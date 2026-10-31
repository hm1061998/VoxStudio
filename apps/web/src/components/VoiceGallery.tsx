import type { VoiceDto } from '@voxstudio/contracts';
import { accentName, tierNote, useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { AiBadge, labelFor } from './VoiceProfilePanel';
import { VoiceSample } from './VoiceSample';
import { Dialog } from './ui';

/** Short sentence each voice reads when the user presses "listen". It is synthesized live by the voice itself. */
const SAMPLE_TEXT: Record<string, string> = {
  vi: 'Xin chào, tôi là giọng đọc của bạn. Hôm nay trời đẹp quá!',
  en: 'Hello, this is a sample of my voice. What a lovely day!',
};
export const sampleTextFor = (locale: string): string =>
  SAMPLE_TEXT[locale.split('-')[0]!.toLowerCase()] ?? SAMPLE_TEXT.en!;

/**
 * Visual voice chooser: one card per voice with region, gender, AI label and a real "listen" button.
 * Selection uses native radio inputs (keyboard: arrow keys), the listen button is a separate control.
 */
export function VoiceGallery({
  voices,
  all,
  value,
  onChange,
  name = 'voice',
}: {
  voices: VoiceDto[];
  /** Every voice (used to disambiguate labels). */
  all: VoiceDto[];
  value: string;
  onChange: (id: string) => void;
  name?: string;
}) {
  const { t, lang } = useI18n();
  return (
    <fieldset className="min-w-0">
      <legend className="label">{t('create.voice')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {voices.map((v) => {
          const selected = v.id === value;
          return (
            <div
              key={v.id}
              className={`card flex flex-col gap-2 p-3 ${selected ? 'border-accent ring-1 ring-accent' : ''}`}
            >
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name={name}
                  value={v.id}
                  checked={selected}
                  onChange={() => onChange(v.id)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {v.displayName.includes('—')
                      ? v.displayName.split('—').pop()!.trim()
                      : labelFor(v, all, lang)}
                    <AiBadge usesAi={v.usesAi} />
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {[
                      v.accent ? accentName(v.accent, lang) : null,
                      v.gender ? t(`profile.gender.${v.gender}` as MessageKey) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-dim">
                    {tierNote(v.supportTier)}
                  </span>
                </span>
              </label>
              <VoiceSample compact voiceId={v.id} locale={v.locale} text={sampleTextFor(v.locale)} />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The same chooser in a dialog (used from the studio, where the side panel is narrow). */
export function VoiceGalleryDialog({
  voices,
  all,
  value,
  onPick,
  onClose,
}: {
  voices: VoiceDto[];
  all: VoiceDto[];
  value: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={t('gallery.title')} onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">{t('gallery.hint')}</p>
      <div className="max-h-[60vh] overflow-auto pr-1 scroll-thin">
        <VoiceGallery
          voices={voices}
          all={all}
          value={value}
          name="gallery-voice"
          onChange={(id) => {
            onPick(id);
          }}
        />
      </div>
      <div className="mt-4 flex justify-end">
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}
