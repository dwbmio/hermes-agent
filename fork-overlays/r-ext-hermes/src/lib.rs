use serde_json::Value;
use std::collections::BTreeSet;

const MAX_INPUT: usize = 262_144;

fn identity(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.trim() == *s && !s.chars().any(char::is_control))
}

fn same_id(a: &Value, b: &Value) -> bool {
    identity(a).is_some_and(|s| identity(b) == Some(s))
}

fn optional_exact(value: &Value, expected: &str) -> bool {
    value.is_null() || value.as_str() == Some(expected)
}

type Seat<'a> = (&'a str, Option<&'a str>);

fn members(value: &Value) -> Option<BTreeSet<Seat<'_>>> {
    let rows = value.as_array()?;
    let seats = rows
        .iter()
        .map(|row| {
            let profile = identity(&row["id"])?;
            let installation = if row["peer"].as_bool()? {
                let installation = identity(&row["installation"])?;
                if installation.strip_prefix("install:")?.is_empty() {
                    return None;
                }
                Some(installation)
            } else {
                None
            };
            Some((profile, installation))
        })
        .collect::<Option<BTreeSet<_>>>()?;
    (seats.len() == rows.len()).then_some(seats)
}

fn mirror(value: &Value) -> bool {
    let Some(rooms) = value["rooms"].as_array() else {
        return false;
    };
    let seated = members(&value["seated"]);
    let matches = |room: &&Value| match value["kind"].as_str() {
        Some("bound") => {
            same_id(&value["room"], &room["room"])
                && same_id(&value["connection"], &room["connection"])
                && same_id(&value["profile"], &room["profile"])
        }
        Some("legacy") => same_id(&value["room"], &room["room"]),
        Some("metadata") => {
            same_id(&value["name"], &room["name"])
                && seated
                    .as_ref()
                    .is_some_and(|a| !a.is_empty() && members(&room["members"]).as_ref() == Some(a))
        }
        _ => false,
    };
    rooms.iter().filter(matches).take(2).count() == 1
}

/// Stable wire ABI, revision 1: 0 rejects, 1 accepts, 2 clarifies, 3 answers inline.
pub fn evaluate(json: &str) -> u32 {
    if json.len() > MAX_INPUT {
        return 0;
    }
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return 0;
    };
    let allowed = match v["op"].as_str() {
        Some("intake") => {
            return match v["action"].as_bool() {
                Some(false) => 3,
                Some(true) if v["suitable"].as_bool() == Some(false) => 0,
                Some(true)
                    if ["suitable", "clear", "authorized"]
                        .into_iter()
                        .all(|key| v[key].as_bool() == Some(true)) =>
                {
                    1
                }
                Some(true) => 2,
                None => 0,
            }
        }
        Some("identity") => identity(&v["value"]).is_some(),
        Some("owner") => v["subscriptions"].as_array().is_some_and(|rows| {
            let [owner] = rows.as_slice() else {
                return false;
            };
            same_id(&owner["task_id"], &v["task"])
                && matches!(
                    owner["platform"].as_str(),
                    Some("local" | "tui" | "api_server")
                )
                && identity(&owner["chat_id"]).is_some()
                && identity(&owner["notifier_profile"]).is_some()
                && optional_exact(&owner["thread_id"], "")
                && optional_exact(&owner["chat_type"], "dm")
        }),
        Some("snapshot") => {
            let s = &v["snapshot"];
            same_id(&s["session_id"], &s["stored_session_id"])
                && matches!(
                    s["info"]["source"].as_str(),
                    Some("local" | "desktop" | "gui" | "tui" | "cli" | "api_server")
                )
        }
        Some("receipt") => {
            let r = &v["receipt"];
            identity(&r["admission_id"]).is_some()
                && same_id(&v["session"], &r["ref"]["session_id"])
                && identity(&r["ref"]["profile_id"]).is_some()
                && (v["profile"].is_null() || same_id(&v["profile"], &r["ref"]["profile_id"]))
                && matches!(
                    r["status"].as_str(),
                    Some("queued" | "started" | "terminal")
                )
        }
        Some("mirror") => mirror(&v),
        _ => false,
    };
    u32::from(allowed)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{evaluate, MAX_INPUT};

    static mut INPUT: [u8; MAX_INPUT] = [0; MAX_INPUT];

    #[no_mangle]
    extern "C" fn r_ext_abi() -> u32 {
        1
    }

    #[no_mangle]
    extern "C" fn r_ext_input() -> *mut u8 {
        std::ptr::addr_of_mut!(INPUT).cast()
    }

    #[no_mangle]
    extern "C" fn r_ext_evaluate(len: usize) -> u32 {
        if len > MAX_INPUT {
            return 0;
        }
        // The unshared renderer instance writes into this buffer synchronously,
        // before invoking the export; no host callback can re-enter evaluation.
        let input = unsafe { std::slice::from_raw_parts(r_ext_input(), len) };
        std::str::from_utf8(input).map_or(0, evaluate)
    }
}

#[cfg(feature = "python")]
mod python {
    use pyo3::prelude::*;

    #[pyfunction]
    fn evaluate_json(input: &str) -> u32 {
        super::evaluate(input)
    }

    #[pyfunction]
    fn intake(raw_args: &str) -> &'static str {
        let Ok(mut input) = serde_json::from_str::<serde_json::Value>(raw_args) else {
            return "unavailable";
        };
        let Some(fields) = input.as_object_mut() else {
            return "unavailable";
        };
        fields.insert("op".into(), "intake".into());
        match super::evaluate(&input.to_string()) {
            1 => "handoff-ready",
            2 => "clarify",
            3 => "inline",
            _ => "unavailable",
        }
    }

    #[pyfunction]
    fn register(ctx: &Bound<'_, PyAny>) -> PyResult<()> {
        let handler = wrap_pyfunction!(intake, ctx.py())?;
        ctx.call_method1(
            "register_command",
            (
                "r-ext-intake",
                handler,
                "Check typed handoff facts without dispatching",
                "<json>",
            ),
        )?;
        Ok(())
    }

    #[pymodule]
    fn r_ext_hermes(module: &Bound<'_, PyModule>) -> PyResult<()> {
        module.add_function(wrap_pyfunction!(register, module)?)?;
        module.add_function(wrap_pyfunction!(evaluate_json, module)?)?;
        module.add("ABI_VERSION", 1)?;
        Ok(())
    }
}
