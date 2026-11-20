use r_ext_hermes::evaluate;

#[test]
fn intake_distinguishes_questions_actions_and_unsettled_execution() {
    assert_eq!(evaluate(r#"{"op":"intake","action":false}"#), 3);
    assert_eq!(
        evaluate(r#"{"op":"intake","action":true,"suitable":true}"#),
        2
    );
    assert_eq!(
        evaluate(r#"{"op":"intake","action":true,"suitable":true,"clear":true,"authorized":true}"#),
        1
    );
    assert_eq!(
        evaluate(r#"{"op":"intake","action":true,"suitable":false,"authorized":true}"#),
        0
    );
    assert_eq!(evaluate(r#"{"op":"intake","action":"yes"}"#), 0);
}

#[test]
fn only_a_unique_exact_owner_can_move_the_notification() {
    let owner = r#"{"task_id":"t_a","platform":"local","chat_id":"logical","notifier_profile":"default","chat_type":"dm"}"#;
    let valid = format!(r#"{{"op":"owner","task":"t_a","subscriptions":[{owner}]}}"#);
    assert_eq!(evaluate(&valid), 1);
    assert_eq!(evaluate(&valid.replace("logical", " logical")), 0);
    assert_eq!(evaluate(&valid.replace("dm", "group")), 0);
    assert_eq!(evaluate(&valid.replace("[", "[null,")), 0);
}

#[test]
fn mirror_requires_unambiguous_room_identity() {
    let valid = r#"{"op":"mirror","kind":"metadata","name":"Room","seated":[{"id":"p1","peer":false}],"rooms":[{"name":"Room","members":[{"id":"p1","peer":false}]}]}"#;
    assert_eq!(evaluate(valid), 1);
    assert_eq!(evaluate(&valid.replacen("false", "true", 1)), 0);
    assert_eq!(
        evaluate(&valid.replace(r#"[{"id":"p1","peer":false}]"#, "[]")),
        0
    );
    assert_eq!(evaluate(&valid.replace("metadata", "independent")), 0);
    assert_eq!(
        evaluate(
            r#"{"op":"mirror","kind":"legacy","room":"id","rooms":[{"room":"id"},{"room":"id"}]}"#
        ),
        0
    );
}

#[test]
fn receipt_must_be_authoritative_exact_and_accepted() {
    let valid = r#"{"op":"receipt","session":"owner","profile":"default","receipt":{"admission_id":"admit","ref":{"session_id":"owner","profile_id":"default"},"status":"queued"}}"#;
    assert_eq!(evaluate(valid), 1);
    assert_eq!(evaluate(&valid.replace("queued", "unknown")), 0);
    assert_eq!(evaluate(&valid.replacen("default", "another", 1)), 0);
    assert_eq!(evaluate("{not json}"), 0);
}

#[test]
fn peer_installation_is_required_and_not_interchangeable() {
    let different = r#"{"op":"mirror","kind":"metadata","name":"Room","seated":[{"id":"default","peer":true,"installation":"install:a"}],"rooms":[{"name":"Room","members":[{"id":"default","peer":true,"installation":"install:b"}]}]}"#;
    assert_eq!(evaluate(different), 0);
    assert_eq!(evaluate(&different.replace("install:b", "install:a")), 1);
    assert_eq!(
        evaluate(&different.replace(r#","installation":"install:b""#, "")),
        0
    );
}
