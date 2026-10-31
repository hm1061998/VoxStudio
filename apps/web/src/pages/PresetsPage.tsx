import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SETTING_KEYS, type PartialSettings, type PresetDto, type SettingKey } from '@voxstudio/contracts';
import { api, describeError } from '../api/client';
import { qk, usePresets, useVoice, useVoices } from '../api/hooks';
import { defaultVoiceFor } from '../studio/voicePick';
import { Confirm, Dialog, Empty, ErrorNote, Spinner, SupportBadge } from '../components/ui';
import { presetDesc, presetName, settingLabel, translate, useI18n, variantLabel } from '../i18n';

export function PresetsPage() {
  const { t } = useI18n();
  const presets = usePresets();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ preset: PresetDto | null; copyFrom?: PresetDto } | null>(null);
  const [deleting, setDeleting] = useState<PresetDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.presets });
  return (
    <div className="h-full overflow-auto p-6 scroll-thin">
      <header className="mb-4 flex items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold">{t('presets.title')}</h1>
        <button className="btn btn-primary" onClick={() => setEditing({ preset: null })}>
          {t('presets.new')}
        </button>
      </header>
      <p className="mb-4 max-w-3xl text-sm text-muted">{t('presets.intro')}</p>
      {error && (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      )}
      {presets.isLoading && <Spinner />}
      {presets.error && <ErrorNote error={presets.error} />}
      {presets.data?.length === 0 && <Empty title={t('presets.none')} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {presets.data?.map((p) => (
          <article key={p.id} className="card flex flex-col p-4">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">{presetName(p)}</h2>
              {p.isBuiltin && (
                <span className="badge bg-line text-muted">{t('preset.builtin').replace(/[()]/g, '')}</span>
              )}
            </div>
            <p className="mt-1 flex-1 text-xs text-muted">{presetDesc(p) || t('presets.noDesc')}</p>
            <ul className="mt-2 flex flex-wrap gap-1">
              {Object.entries(p.parameters).map(([k, v]) => (
                <li key={k} className="badge bg-panel-2 text-muted">
                  {settingLabel(k as SettingKey)}: {String(v)}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-1">
              <button className="btn btn-sm" onClick={() => setEditing({ preset: null, copyFrom: p })}>
                {t('common.duplicate')}
              </button>
              {!p.isBuiltin && (
                <>
                  <button className="btn btn-sm" onClick={() => setEditing({ preset: p })}>
                    {t('common.edit')}
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => setDeleting(p)}>
                    {t('common.delete')}
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <PresetEditor
          preset={editing.preset}
          copyFrom={editing.copyFrom}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      )}
      {deleting && (
        <Confirm
          danger
          title={t('presets.deleteTitle')}
          message={t('presets.deleteMsg', { name: deleting.name })}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void api(`/presets/${deleting.id}`, { method: 'DELETE' })
              .then(refresh)
              .catch((e) => setError(describeError(e)))
          }
        />
      )}
    </div>
  );
}

function PresetEditor({
  preset,
  copyFrom,
  onClose,
  onSaved,
}: {
  preset: PresetDto | null;
  copyFrom?: PresetDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  // Capabilities only describe which controls exist; any installed voice of the first language will do.
  const voices = useVoices();
  const sample = voices.data ? defaultVoiceFor(voices.data, voices.data[0]?.locale ?? 'vi-VN') : undefined;
  const caps = useVoice(sample?.id ?? null).data?.capabilities;
  const src = preset ?? copyFrom;
  const [name, setName] = useState(
    preset?.name ?? (copyFrom ? `${presetName(copyFrom)}${translate('presets.copySuffix')}` : ''),
  );
  const [description, setDescription] = useState(src ? presetDesc(src) : '');
  const [params, setParams] = useState<PartialSettings>(src?.parameters ?? {});
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: SettingKey, on: boolean) => {
    const next = { ...params } as Record<string, unknown>;
    if (on && caps) next[k] = caps[k].default;
    else delete next[k];
    setParams(next as PartialSettings);
  };
  const save = async () => {
    setError(null);
    try {
      await api(preset ? `/presets/${preset.id}` : '/presets', {
        method: preset ? 'PATCH' : 'POST',
        body: { name, description, parameters: params },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <Dialog title={preset ? t('presets.editTitle') : t('presets.newTitle')} onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="pn">
            {t('presets.name')}
          </label>
          <input
            id="pn"
            className="input"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="pd">
            {t('presets.desc')}
          </label>
          <input
            id="pd"
            className="input"
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{t('presets.tickHint')}</p>
      {!caps && <Spinner />}
      {caps && (
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2">
          {SETTING_KEYS.map((k) => {
            const c = caps[k];
            const on = k in params;
            const v = (params as Record<string, unknown>)[k];
            const label = settingLabel(k, c);
            return (
              <div key={k} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  id={`pp-${k}`}
                  checked={on}
                  onChange={(e) => toggle(k, e.target.checked)}
                />
                <label htmlFor={`pp-${k}`} className="w-36 truncate" title={label}>
                  {label}
                </label>
                <SupportBadge support={c.support} />
                {on && c.kind === 'number' && (
                  <input
                    type="number"
                    aria-label={t('insp.valueAria', { label })}
                    className="input w-24 py-0.5 text-xs"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={Number(v)}
                    onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })}
                  />
                )}
                {on && c.kind === 'boolean' && (
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={Boolean(v)}
                    onChange={(e) => setParams({ ...params, [k]: e.target.checked })}
                  />
                )}
                {on && c.kind === 'enum' && (
                  <select
                    aria-label={t('insp.valueAria', { label })}
                    className="input w-28 py-0.5 text-xs"
                    value={String(v)}
                    onChange={(e) => setParams({ ...params, [k]: e.target.value })}
                  >
                    {c.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {variantLabel(o.value, o.label)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void save()}>
          {t('presets.save')}
        </button>
      </div>
    </Dialog>
  );
}
