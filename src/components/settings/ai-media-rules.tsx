'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Pencil, Paperclip, Upload, X, FileAudio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';

const MEDIA_BUCKET = 'chat-media';

const DOCUMENT_ACCEPT: Record<'image' | 'document', string> = {
  image: 'image/png,image/jpeg,image/webp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
};
const AUDIO_ACCEPT = 'audio/ogg,audio/mpeg,audio/aac,audio/mp4,audio/amr';

interface RuleSummary {
  id: string;
  name: string;
  keywords: string[];
  match_type: 'exact' | 'contains';
  case_sensitive: boolean;
  document_url: string;
  document_kind: 'image' | 'document';
  document_filename: string | null;
  audio_url: string;
  audio_filename: string | null;
  is_active: boolean;
  position: number;
}

type EditTarget = 'new' | string | null;

interface DraftState {
  name: string;
  keywordsText: string;
  matchType: 'exact' | 'contains';
  caseSensitive: boolean;
  documentUrl: string;
  documentKind: 'image' | 'document';
  documentFilename: string;
  audioUrl: string;
  audioFilename: string;
  isActive: boolean;
}

function blankDraft(): DraftState {
  return {
    name: '',
    keywordsText: '',
    matchType: 'contains',
    caseSensitive: false,
    documentUrl: '',
    documentKind: 'image',
    documentFilename: '',
    audioUrl: '',
    audioFilename: '',
    isActive: true,
  };
}

export function AiMediaRulesCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [draft, setDraft] = useState<DraftState>(blankDraft());
  const [saving, setSaving] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations('Settings.aiMediaRules');

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/media-rules');
      const data = await res.json();
      if (res.ok) setRules(data.rules ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchRules();
  }, [accountId, fetchRules]);

  const openNew = () => {
    setEditing('new');
    setDraft(blankDraft());
  };

  const openEdit = (rule: RuleSummary) => {
    setEditing(rule.id);
    setDraft({
      name: rule.name,
      keywordsText: rule.keywords.join(', '),
      matchType: rule.match_type,
      caseSensitive: rule.case_sensitive,
      documentUrl: rule.document_url,
      documentKind: rule.document_kind,
      documentFilename: rule.document_filename ?? '',
      audioUrl: rule.audio_url,
      audioFilename: rule.audio_filename ?? '',
      isActive: rule.is_active,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft(blankDraft());
  };

  const handleDocFile = useCallback(
    async (file: File) => {
      const maxBytes = MEDIA_MAX_BYTES_BY_KIND[draft.documentKind];
      if (file.size > maxBytes) {
        toast.error(t('fileTooLarge', { limit: (maxBytes / 1024 / 1024).toFixed(0) }));
        return;
      }
      setUploadingDoc(true);
      try {
        const { publicUrl } = await uploadAccountMedia(MEDIA_BUCKET, file);
        setDraft((d) => ({ ...d, documentUrl: publicUrl, documentFilename: file.name }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('uploadFailed'));
      } finally {
        setUploadingDoc(false);
      }
    },
    [draft.documentKind, t],
  );

  const handleAudioFile = useCallback(
    async (file: File) => {
      const maxBytes = MEDIA_MAX_BYTES_BY_KIND.audio;
      if (file.size > maxBytes) {
        toast.error(t('fileTooLarge', { limit: (maxBytes / 1024 / 1024).toFixed(0) }));
        return;
      }
      setUploadingAudio(true);
      try {
        const { publicUrl } = await uploadAccountMedia(MEDIA_BUCKET, file);
        setDraft((d) => ({ ...d, audioUrl: publicUrl, audioFilename: file.name }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('uploadFailed'));
      } finally {
        setUploadingAudio(false);
      }
    },
    [t],
  );

  const save = async () => {
    const keywords = draft.keywordsText
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!draft.name.trim() || keywords.length === 0) {
      toast.error(t('nameKeywordsRequired'));
      return;
    }
    if (!draft.documentUrl || !draft.audioUrl) {
      toast.error(t('filesRequired'));
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/media-rules' : `/api/ai/media-rules/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name.trim(),
            keywords,
            match_type: draft.matchType,
            case_sensitive: draft.caseSensitive,
            document_url: draft.documentUrl,
            document_kind: draft.documentKind,
            document_filename: draft.documentFilename || null,
            audio_url: draft.audioUrl,
            audio_filename: draft.audioFilename || null,
            is_active: draft.isActive,
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(isNew ? t('saveSuccessNew') : t('saveSuccessUpdate'));
        cancelEdit();
        await fetchRules();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/media-rules/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setRules((r) => r.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {rules.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">{t('noRules')}</p>
            )}

            {rules.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-foreground">{rule.name}</span>
                        {!rule.is_active && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t('inactive')}
                          </span>
                        )}
                      </div>
                      <span className="truncate text-xs text-muted-foreground">
                        {rule.keywords.join(', ')}
                      </span>
                    </div>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEdit(rule)}
                          title={t('edit')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(rule.id)}
                          title={t('delete')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="mr-name">{t('nameLabel')}</Label>
                  <Input
                    id="mr-name"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t('namePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mr-keywords">{t('keywordsLabel')}</Label>
                  <Input
                    id="mr-keywords"
                    value={draft.keywordsText}
                    onChange={(e) => setDraft((d) => ({ ...d, keywordsText: e.target.value }))}
                    placeholder={t('keywordsPlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label>{t('matchTypeLabel')}</Label>
                    <Select
                      value={draft.matchType}
                      onValueChange={(v) =>
                        setDraft((d) => ({ ...d, matchType: v as 'exact' | 'contains' }))
                      }
                    >
                      <SelectTrigger className="bg-muted">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="contains">{t('matchContains')}</SelectItem>
                        <SelectItem value="exact">{t('matchExact')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end justify-between rounded-md border border-border px-3 py-2">
                    <Label htmlFor="mr-case" className="text-xs">
                      {t('caseSensitiveLabel')}
                    </Label>
                    <Switch
                      id="mr-case"
                      checked={draft.caseSensitive}
                      onCheckedChange={(v) => setDraft((d) => ({ ...d, caseSensitive: v }))}
                      disabled={saving}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('documentLabel')}</Label>
                  <Select
                    value={draft.documentKind}
                    onValueChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        documentKind: v as 'image' | 'document',
                        documentUrl: '',
                        documentFilename: '',
                      }))
                    }
                  >
                    <SelectTrigger className="bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="image">{t('kindImage')}</SelectItem>
                      <SelectItem value="document">{t('kindDocument')}</SelectItem>
                    </SelectContent>
                  </Select>
                  {draft.documentUrl ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {draft.documentFilename || draft.documentUrl}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({ ...d, documentUrl: '', documentFilename: '' }))
                        }
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        disabled={uploadingDoc}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => docInputRef.current?.click()}
                      disabled={uploadingDoc}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {uploadingDoc ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('uploading')}
                        </>
                      ) : (
                        <>
                          <Upload className="h-3.5 w-3.5" /> {t('clickToUploadDocument')}
                        </>
                      )}
                    </button>
                  )}
                  <input
                    ref={docInputRef}
                    type="file"
                    accept={DOCUMENT_ACCEPT[draft.documentKind]}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleDocFile(file);
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('audioLabel')}</Label>
                  {draft.audioUrl ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
                      <FileAudio className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {draft.audioFilename || draft.audioUrl}
                      </span>
                      <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, audioUrl: '', audioFilename: '' }))}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        disabled={uploadingAudio}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => audioInputRef.current?.click()}
                      disabled={uploadingAudio}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {uploadingAudio ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('uploading')}
                        </>
                      ) : (
                        <>
                          <Upload className="h-3.5 w-3.5" /> {t('clickToUploadAudio')}
                        </>
                      )}
                    </button>
                  )}
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept={AUDIO_ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleAudioFile(file);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t('audioHint')}</p>
                </div>

                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <Label htmlFor="mr-active" className="text-xs">
                    {t('activeLabel')}
                  </Label>
                  <Switch
                    id="mr-active"
                    checked={draft.isActive}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, isActive: v }))}
                    disabled={saving}
                  />
                </div>

                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving || uploadingDoc || uploadingAudio}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveRule')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button variant="outline" size="sm" onClick={openNew}>
                  <Plus className="mr-2 h-4 w-4" /> {t('addRule')}
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
