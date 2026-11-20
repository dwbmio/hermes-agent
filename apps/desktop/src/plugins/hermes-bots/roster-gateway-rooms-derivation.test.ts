/**
 * Gateway Group Chats in the roster derivation. A gateway room is not a
 * Desktop room record: a Desktop room with the same name must not lend it a
 * section or a saved order. A room an open view reports as working stays
 * Active past the recency window.
 */

import { describe, expect, it } from 'vitest'

import { canonicalRoomLiveKey } from './canonical-group-details'
import type { GatewayGroupRoom } from './canonical-group-registry'
import { deriveRosterRows } from './roster-pane-derivation'
import type { RosterRow } from './types'
import { groupRowsBySection } from './user-sections'

const binding = { connectionId: 'local', profile: 'default', roomId: 'room-1', roomName: 'Team' }
const HOUR = 3600_000

const gatewayRoom: GatewayGroupRoom = {
  binding,
  key: 'canonical:local:default:room-1',
  members: [],
  name: 'Team',
  room: { room_id: 'room-1', name: 'Team', members: [] },
  updatedAt: Date.now() - HOUR
}

const { $rExtPolicy, enableBundledPolicy } = await import('@/contrib/r-ext-policy')
enableBundledPolicy()

function derive(overrides: Partial<Parameters<typeof deriveRosterRows>[0]> = {}) {
  return deriveRosterRows({
    mirrorPolicy: $rExtPolicy.get(),
    roster: [],
    allMeta: {},
    gatewayFilter: 'all',
    query: '',
    activityFilter: 'all',
    rowKindFilter: 'all',
    groupRooms: {},
    gatewayRooms: [gatewayRoom],
    gatewayRoomLive: {},
    activeRosterKeys: new Set(),
    gatewayOptions: [],
    activityOf: () => 0,
    isPinned: () => false,
    ...overrides
  })
}

describe('gateway Group Chats in the roster', () => {
  it('a same-name Desktop room lends a gateway room neither its section nor its saved order', () => {
    const desktop = { Team: { members: [], rosterOrder: 0, sectionId: 'work' } } as never
    const gateway = derive({ groupRooms: desktop }).sortedGroupRows.find(row => row.gateway)!
    const blocks = groupRowsBySection([gateway], [{ id: 'work', name: 'Work' }], {}, desktop)

    expect(blocks.find(block => block.id === 'work')!.rows).toEqual([])
    expect(blocks.find(block => block.id === null)!.rows).toEqual([gateway])
  })

  it('stays Active while an open view reports it working, past the recency window', () => {
    const live = { [canonicalRoomLiveKey(binding, 'room-1')]: { working: true, failed: false, needsYou: false } }

    expect(derive({ activityFilter: 'active' }).sortedGroupRows).toEqual([])
    expect(derive({ activityFilter: 'active', gatewayRoomLive: live }).sortedGroupRows.map(row => row.name)).toEqual([
      'Team'
    ])
  })
})

/** A room's members as `groups.list` seats them: local profiles on the room's
 *  own connection. */
function localMember(profile: string) {
  return { member_id: profile, profile, handle: profile, target: { kind: 'local', profile } }
}

function roomWithMembers(memberProfiles: string[], overrides: Partial<GatewayGroupRoom> = {}): GatewayGroupRoom {
  const members = memberProfiles.map(localMember)

  return {
    ...gatewayRoom,
    members,
    room: { room_id: binding.roomId, name: gatewayRoom.name, members },
    ...overrides
  }
}

/** The bot-meta projection of a gateway room: bots whose ui_meta names it,
 *  with no Desktop room record on this window. */
function metaProjection(names: string[], group: string) {
  const roster: RosterRow[] = names.map(name => ({ name }))
  const allMeta = Object.fromEntries(names.map(name => [name, { groups: [group] }]))

  return { roster, allMeta }
}

describe('gateway room mirrors in the roster', () => {
  it('a metadata-only projection of a listed gateway room shows only the gateway row', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')
    const result = derive({ roster, allMeta, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(1)
    expect(teamRows[0].gateway?.binding.roomId).toBe('room-1')
  })

  it('a Desktop record bound to a listed gateway room shows only the gateway row', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')

    const groupRooms = {
      Team: {
        log: [],
        watermarks: {},
        members: [{ name: 'alpha' }, { name: 'beta' }],
        engine: { kind: 'gateway' as const, connectionId: 'local', profile: 'default', roomId: 'room-1' }
      }
    }

    const result = derive({ roster, allMeta, groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(1)
    expect(teamRows[0].gateway?.binding.roomId).toBe('room-1')
  })

  it('a legacy Desktop record carrying the room id shows only the gateway row', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')

    const groupRooms = {
      Team: { log: [], watermarks: {}, members: [{ name: 'alpha' }, { name: 'beta' }], roomId: 'room-1' }
    }

    const result = derive({ roster, allMeta, groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(1)
    expect(teamRows[0].gateway?.binding.roomId).toBe('room-1')
  })

  it('a layout-only record does not keep a mirror row alive', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')
    const groupRooms = { Team: { log: [], watermarks: {}, sectionId: 'work', rosterOrder: 0 } }
    const result = derive({ roster, allMeta, groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(1)
    expect(teamRows[0].gateway?.binding.roomId).toBe('room-1')
  })

  it('an independent classic Desktop room keeps its row beside a same-name gateway room', () => {
    const groupRooms = {
      Team: {
        log: [{ at: 1, from: { kind: 'user' as const, name: 'user' }, text: 'hi' }],
        watermarks: {},
        members: [{ name: 'alpha' }],
        engine: 'desktop' as const
      }
    }

    const result = derive({ groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(2)
    expect(teamRows.filter(row => !row.gateway)).toHaveLength(1)
    expect(teamRows.filter(row => row.gateway?.binding.roomId === 'room-1')).toHaveLength(1)
  })

  it('a classic Desktop room with no gateway namesake is untouched', () => {
    const groupRooms = {
      Side: {
        log: [{ at: 1, from: { kind: 'user' as const, name: 'user' }, text: 'hi' }],
        watermarks: {},
        members: [{ name: 'alpha' }],
        engine: 'desktop' as const
      }
    }

    const result = derive({ groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    expect(result.sortedGroupRows.map(row => row.name).sort()).toEqual(['Side', 'Team'])
  })

  it('a Desktop record bound to a room the gateway no longer lists keeps its row', () => {
    const groupRooms = {
      Team: {
        log: [],
        watermarks: {},
        members: [{ name: 'alpha' }],
        engine: { kind: 'gateway' as const, connectionId: 'local', profile: 'default', roomId: 'room-gone' }
      }
    }

    const result = derive({ groupRooms, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(2)
    expect(teamRows.filter(row => !row.gateway)).toHaveLength(1)
  })

  it('a metadata projection with different members is not a mirror', () => {
    const { roster, allMeta } = metaProjection(['alpha'], 'Team')
    const result = derive({ roster, allMeta, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(2)
    expect(teamRows.filter(row => !row.gateway)).toHaveLength(1)
  })

  it('same-name rooms on different gateways never merge', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')
    const remoteMembers = [localMember('gamma'), localMember('delta')]

    const remoteRoom: GatewayGroupRoom = {
      binding: { connectionId: 'remote-1', profile: 'default', roomId: 'room-9', roomName: 'Team' },
      key: 'canonical:remote-1:default:room-9',
      members: remoteMembers,
      name: 'Team',
      room: { room_id: 'room-9', name: 'Team', members: remoteMembers },
      updatedAt: Date.now() - HOUR
    }

    const result = derive({ roster, allMeta, gatewayRooms: [roomWithMembers(['alpha', 'beta']), remoteRoom] })

    const teamRows = result.sortedGroupRows.filter(row => row.name === 'Team')
    expect(teamRows).toHaveLength(2)
    expect(teamRows.map(row => row.gateway?.binding.roomId).sort()).toEqual(['room-1', 'room-9'])
  })

  it('counts, search and kind filters see the room once', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')
    const base = { roster, allMeta, gatewayRooms: [roomWithMembers(['alpha', 'beta'])] }

    expect(derive(base).groupNames.filter(name => name === 'Team')).toHaveLength(1)
    expect(derive({ ...base, query: 'Team' }).sortedGroupRows.filter(row => row.name === 'Team')).toHaveLength(1)
    expect(derive({ ...base, query: 'alpha' }).sortedGroupRows.filter(row => row.name === 'Team')).toHaveLength(1)
    expect(derive({ ...base, rowKindFilter: 'groups' }).sortedGroupRows.filter(row => row.name === 'Team')).toHaveLength(1)
    expect(derive({ ...base, rowKindFilter: 'bots' }).sortedGroupRows.filter(row => row.kind === 'group')).toHaveLength(0)
  })

  it('an activity filter never resurrects a shadowed mirror row', () => {
    const { roster, allMeta } = metaProjection(['alpha', 'beta'], 'Team')

    const result = derive({
      roster,
      allMeta,
      gatewayRooms: [roomWithMembers(['alpha', 'beta'])],
      activityFilter: 'active',
      activeRosterKeys: new Set(['legacy::alpha'])
    })

    expect(result.sortedGroupRows.filter(row => row.name === 'Team')).toEqual([])
  })
})
