/**
 * Custody, collections and privacy. These change who may see and edit a
 * record, so they happen online, through server functions that check
 * permissions (supabase/migrations/20261117000003_custody.sql). The phone
 * keeps a copy of the user's collections to decide which controls to show;
 * the server has the final say.
 */
import { db, type Custody, type Visibility } from '../db/schema'
import { supabase } from '../lib/supabase'

export type Role = 'curator' | 'staff' | 'viewer'

export interface Organization {
  id: string
  name: string
  code: string
}

export interface Membership extends Organization {
  role: Role
}

export type Purpose = 'accession' | 'loan' | 'gift' | 'return' | 'other'

export interface Transfer {
  id: string
  tag_id: string
  from_user: string | null
  from_org: string | null
  from_label: string
  to_user: string | null
  to_org: string | null
  to_label: string
  purpose: Purpose
  note: string | null
  scan_id: string | null
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  catalog_number: string | null
  created_by: string
  created_at: string
  responded_at: string | null
  /** Transfers sent together share a batch. */
  batch_id: string | null
}

export interface Share {
  id: string
  tag_id: string
  user_id: string | null
  org_id: string | null
  label: string
}

/** Recipient of a transfer or share: a collection, or a person by email. */
export type Party = { orgId: string } | { email: string }

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}

const party = (p: Party) => ('orgId' in p ? { p_org: p.orgId, p_email: null } : { p_org: null, p_email: p.email.trim() })

// ---- Collections -------------------------------------------------------

const MY_ORGS = 'myOrgs'

/** Join collections that invited this email, then cache the memberships. */
export async function refreshMemberships(userId: string): Promise<Membership[]> {
  await supabase.rpc('accept_invites')
  const rows = check(
    await supabase.from('org_members').select('role, organizations (id, name, code)').eq('user_id', userId),
  ) as unknown as { role: Role; organizations: Organization | Organization[] }[]
  const mine = rows.map((r) => ({ ...(Array.isArray(r.organizations) ? r.organizations[0] : r.organizations), role: r.role }))
  await db.meta.put({ key: MY_ORGS, value: mine })
  return mine
}

export async function cachedMemberships(): Promise<Membership[]> {
  return ((await db.meta.get(MY_ORGS))?.value as Membership[] | undefined) ?? []
}

export async function listOrganizations(): Promise<Organization[]> {
  return check(await supabase.from('organizations').select('id, name, code').order('name')) ?? []
}

export async function createOrganization(name: string, code: string): Promise<string> {
  return check(await supabase.rpc('create_organization', { p_name: name, p_code: code })) as string
}

export interface Member {
  user_id: string
  role: Role
  name: string
}

export async function listMembers(orgId: string): Promise<Member[]> {
  const rows = check(
    await supabase.from('org_members').select('user_id, role, profiles!org_members_user_id_fkey (display_name)').eq('org_id', orgId),
  ) as unknown as { user_id: string; role: Role; profiles: { display_name: string | null } | null }[]
  return rows.map((r) => ({ user_id: r.user_id, role: r.role, name: r.profiles?.display_name?.trim() || 'Member' }))
}

export async function listInvites(orgId: string): Promise<{ email: string; role: Role }[]> {
  return check(await supabase.from('org_invites').select('email, role').eq('org_id', orgId)) ?? []
}

/** 'added', or 'invited' if the email has no account yet. */
export async function addMember(orgId: string, email: string, role: Role): Promise<'added' | 'invited'> {
  return check(await supabase.rpc('add_member', { p_org: orgId, p_email: email, p_role: role })) as 'added' | 'invited'
}

export async function setMemberRole(orgId: string, userId: string, role: Role) {
  check(await supabase.from('org_members').update({ role }).eq('org_id', orgId).eq('user_id', userId))
}

export async function removeMember(orgId: string, userId: string) {
  check(await supabase.from('org_members').delete().eq('org_id', orgId).eq('user_id', userId))
}

export async function removeInvite(orgId: string, email: string) {
  check(await supabase.from('org_invites').delete().eq('org_id', orgId).eq('email', email))
}

// ---- Permissions (for showing controls; the server enforces) -----------

/** May edit the record: the custodian, or curators and staff of its collection. */
export function canEdit(c: Custody | undefined, userId: string | undefined, orgs: Membership[]): boolean {
  if (!c) return true // not on the server yet: still the creator's
  if (c.custodianUser && c.custodianUser === userId) return true
  return !!c.custodianOrg && orgs.some((o) => o.id === c.custodianOrg && o.role !== 'viewer')
}

/** May change privacy, sharing, catalog number and transfer it. */
export function canCurate(c: Custody | undefined, userId: string | undefined, orgs: Membership[]): boolean {
  if (!c) return true
  if (c.custodianUser && c.custodianUser === userId) return true
  return !!c.custodianOrg && orgs.some((o) => o.id === c.custodianOrg && o.role === 'curator')
}

// ---- Transfers ----------------------------------------------------------

export interface TransferInput {
  /** One tag, or several sent as a batch. */
  tagIds: string[]
  to: Party
  purpose: Purpose
  note: string
  /** Where the object is now (the donor's location log): a fix, a place, or both. */
  fix: { lat: number; lng: number; accuracyM: number } | null
  place: string
}

/** Start a transfer; several tags go as one all-or-nothing batch. */
export async function startTransfer(t: TransferInput): Promise<string> {
  const { p_org, p_email } = party(t.to)
  const one = t.tagIds.length === 1
  return check(
    await supabase.rpc(one ? 'start_transfer' : 'start_transfers', {
      ...(one ? { p_tag: t.tagIds[0] } : { p_tags: t.tagIds }),
      p_to_org: p_org,
      p_to_email: p_email,
      p_purpose: t.purpose,
      p_note: t.note,
      p_lat: t.fix?.lat ?? null,
      p_lng: t.fix?.lng ?? null,
      p_accuracy: t.fix ? Math.round(t.fix.accuracyM) : null,
      p_place: t.place,
    }),
  ) as string
}

export async function respondTransfer(id: string, accept: boolean, catalogNumber = '') {
  check(await supabase.rpc('respond_transfer', { p_id: id, p_accept: accept, p_catalog_number: catalogNumber }))
}

export async function cancelTransfer(id: string) {
  check(await supabase.rpc('cancel_transfer', { p_id: id }))
}

/** Accept or decline a whole batch; catalog numbers keyed by tag. */
export async function respondBatch(batchId: string, accept: boolean, catalog: Record<string, string> = {}) {
  const numbers = Object.fromEntries(Object.entries(catalog).filter(([, v]) => v.trim()))
  return check(await supabase.rpc('respond_transfers', { p_batch: batchId, p_accept: accept, p_catalog: numbers })) as number
}

export async function cancelBatch(batchId: string) {
  return check(await supabase.rpc('cancel_transfers', { p_batch: batchId })) as number
}

/** Transfers grouped by batch (a transfer sent alone is its own group), oldest first. */
export function groupByBatch(transfers: Transfer[]): Transfer[][] {
  const groups = new Map<string, Transfer[]>()
  for (const t of transfers) {
    const key = t.batch_id ?? t.id
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  return [...groups.values()]
}

const TRANSFER_COLUMNS =
  'id, tag_id, from_user, from_org, from_label, to_user, to_org, to_label, purpose, note, scan_id, status, catalog_number, created_by, created_at, responded_at, batch_id'

/** A tag's chain of custody, oldest first. */
export async function transfersFor(tagId: string): Promise<Transfer[]> {
  return check(await supabase.from('custody_transfers').select(TRANSFER_COLUMNS).eq('tag_id', tagId).order('created_at')) ?? []
}

/** Transfers waiting for this user (or their collections) to accept. */
export async function incomingTransfers(userId: string, orgs: Membership[]): Promise<Transfer[]> {
  const curated = orgs.filter((o) => o.role === 'curator').map((o) => o.id)
  const filter = [`to_user.eq.${userId}`, ...(curated.length ? [`to_org.in.(${curated.join(',')})`] : [])].join(',')
  return (
    check(
      await supabase.from('custody_transfers').select(TRANSFER_COLUMNS).eq('status', 'pending').or(filter).order('created_at'),
    ) ?? []
  )
}

/** Transfers this user started that are still waiting, plus recent ones. */
export async function outgoingTransfers(userId: string): Promise<Transfer[]> {
  return (
    check(
      await supabase
        .from('custody_transfers')
        .select(TRANSFER_COLUMNS)
        .eq('created_by', userId)
        .order('created_at', { ascending: false })
        .limit(500),
    ) ?? []
  )
}

// ---- Privacy -------------------------------------------------------------

export async function setPrivacy(tagId: string, visibility: Visibility, generalize: boolean) {
  check(await supabase.rpc('set_privacy', { p_tag: tagId, p_visibility: visibility, p_generalize: generalize }))
}

export async function sharesFor(tagId: string): Promise<Share[]> {
  return check(await supabase.from('object_shares').select('id, tag_id, user_id, org_id, label').eq('tag_id', tagId)) ?? []
}

export async function shareTag(tagId: string, to: Party) {
  check(await supabase.rpc('share_tag', { p_tag: tagId, ...party(to) }))
}

export async function unshareTag(shareId: string) {
  check(await supabase.rpc('unshare_tag', { p_share: shareId }))
}

export async function setCatalogNumber(tagId: string, catalogNumber: string) {
  check(await supabase.rpc('set_catalog_number', { p_tag: tagId, p_catalog_number: catalogNumber }))
}

/** True if no one has used the tag yet (server-wide, including others' tags). */
export async function tagUnclaimed(tagId: string): Promise<boolean> {
  return check(await supabase.rpc('tag_unclaimed', { p_tag: tagId })) as boolean
}

// ---- Public view -----------------------------------------------------------

export interface PublicInfo {
  rank: 'specimen' | 'mixed_lot' | 'subsample'
  species?: string | null
  composition?: { name: string; count: number }[]
  individualCount?: number
  sampleType?: string | null
  preservation?: string | null
  catalogNumber: string | null
  custodian: string
  year: number | null
  lat?: number | null
  lng?: number | null
  generalized?: boolean
  county?: string | null
  stateProvince?: string | null
  countryCode?: string | null
  waterBody?: string | null
  parent?: string
}

/** What anyone can see for a public tag; null if it isn't public. */
export async function publicTagInfo(tagId: string): Promise<PublicInfo | null> {
  return (check(await supabase.rpc('public_tag_info', { p_tag: tagId })) as PublicInfo | null) ?? null
}

/** Names for custodians shown on the phone (collections and people). */
export async function partyName(c: Custody): Promise<string> {
  if (c.custodianOrg) {
    const mine = (await cachedMemberships()).find((o) => o.id === c.custodianOrg)
    if (mine) return `${mine.name} (${mine.code})`
    const { data } = await supabase.from('organizations').select('name, code').eq('id', c.custodianOrg).maybeSingle()
    return data ? `${data.name} (${data.code})` : 'A collection'
  }
  if (c.custodianUser) {
    const { data } = await supabase.from('profiles').select('display_name').eq('id', c.custodianUser).maybeSingle()
    return data?.display_name?.trim() || 'A collector'
  }
  return 'Unknown'
}
