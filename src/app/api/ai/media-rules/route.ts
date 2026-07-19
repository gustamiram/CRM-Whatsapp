import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const SELECT_COLUMNS =
  'id, name, keywords, match_type, case_sensitive, document_url, document_kind, document_filename, audio_url, audio_filename, is_active, position, updated_at'

/**
 * GET /api/ai/media-rules
 *
 * List the account's keyword → media rules (any member) — the AI
 * Agents module's own rule list, independent of the Automations
 * module's `send_media` step type.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_media_rules')
      .select(SELECT_COLUMNS)
      .eq('account_id', accountId)
      .order('position', { ascending: true })
    if (error) {
      console.error('[ai/media-rules GET] error:', error)
      return NextResponse.json(
        { error: 'Failed to load media rules' },
        { status: 500 },
      )
    }
    return NextResponse.json({ rules: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/ai/media-rules  (admin+)
 *
 * Create a rule. Both the document (PDF/image) and the audio are
 * required — a rule only exists once complete, matching "the file is
 * always a PDF/image plus an audio."
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-media-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return bad('name is required')

    const keywords = Array.isArray(body.keywords)
      ? body.keywords
          .map((k: unknown) => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
      : []
    if (keywords.length === 0) return bad('at least one keyword is required')

    const matchType = body.match_type === 'exact' ? 'exact' : 'contains'
    const caseSensitive = body.case_sensitive === true

    const documentUrl = typeof body.document_url === 'string' ? body.document_url.trim() : ''
    const documentKind = body.document_kind === 'document' ? 'document' : 'image'
    const documentFilename =
      typeof body.document_filename === 'string' ? body.document_filename : null
    const audioUrl = typeof body.audio_url === 'string' ? body.audio_url.trim() : ''
    const audioFilename = typeof body.audio_filename === 'string' ? body.audio_filename : null
    if (!documentUrl) return bad('document_url is required')
    if (!audioUrl) return bad('audio_url is required')

    let position = Number(body.position)
    if (!Number.isFinite(position)) position = 0

    const { data: rule, error } = await supabase
      .from('ai_media_rules')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        keywords,
        match_type: matchType,
        case_sensitive: caseSensitive,
        document_url: documentUrl,
        document_kind: documentKind,
        document_filename: documentFilename,
        audio_url: audioUrl,
        audio_filename: audioFilename,
        position,
      })
      .select('id')
      .single()
    if (error || !rule) {
      console.error('[ai/media-rules POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to save rule' }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: rule.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
