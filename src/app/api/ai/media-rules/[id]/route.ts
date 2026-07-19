import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * PATCH /api/ai/media-rules/[id]  (admin+)
 *
 * Partial update — only fields present in the body are touched.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-media-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const update: Record<string, unknown> = {}

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return bad('name cannot be empty')
      update.name = name
    }
    if ('keywords' in body) {
      const keywords = Array.isArray(body.keywords)
        ? body.keywords
            .map((k: unknown) => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
        : []
      if (keywords.length === 0) return bad('at least one keyword is required')
      update.keywords = keywords
    }
    if ('match_type' in body) {
      update.match_type = body.match_type === 'exact' ? 'exact' : 'contains'
    }
    if ('case_sensitive' in body) {
      update.case_sensitive = body.case_sensitive === true
    }
    if ('document_url' in body) {
      const v = typeof body.document_url === 'string' ? body.document_url.trim() : ''
      if (!v) return bad('document_url cannot be empty')
      update.document_url = v
    }
    if ('document_kind' in body) {
      update.document_kind = body.document_kind === 'document' ? 'document' : 'image'
    }
    if ('document_filename' in body) {
      update.document_filename =
        typeof body.document_filename === 'string' ? body.document_filename : null
    }
    if ('audio_url' in body) {
      const v = typeof body.audio_url === 'string' ? body.audio_url.trim() : ''
      if (!v) return bad('audio_url cannot be empty')
      update.audio_url = v
    }
    if ('audio_filename' in body) {
      update.audio_filename =
        typeof body.audio_filename === 'string' ? body.audio_filename : null
    }
    if ('is_active' in body) {
      update.is_active = body.is_active === true
    }
    if ('position' in body) {
      const position = Number(body.position)
      if (Number.isFinite(position)) update.position = position
    }

    if (Object.keys(update).length === 0) return bad('Nothing to update')

    const { data: updated, error } = await supabase
      .from('ai_media_rules')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[ai/media-rules/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update rule' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/media-rules/[id]  (admin+)
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_media_rules')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/media-rules/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete rule' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
