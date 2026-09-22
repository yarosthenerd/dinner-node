import { useState } from 'react';
import { getAvailableTemplates } from '../lib/engram-integration';
import type { PendingEngrams } from '../lib/engram-integration';
import { parseUploadedEngram } from '../lib/engram-library';

interface EngramSelectorProps {
  onSanitizationChange?: (strictness: 'minimal' | 'balanced' | 'maximal') => void;
  onPendingChange?: (pending: PendingEngrams) => void;
}

const LEVEL_NOTE: Record<string, string> = {
  minimal: 'emails, phones, cards, secrets, "I live in X"',
  balanced: 'the above plus addresses, names and identity numbers',
  maximal: 'aggressive: also place names, nationalities, and most capitalised words',
};

export function EngramSelector({ onSanitizationChange, onPendingChange }: EngramSelectorProps) {
  // The template list is a static module constant, so it is initialized rather
  // than fetched in a mount effect: the effect rendered once with an empty
  // dropdown and then again with the real one, for no gain.
  const templates = getAvailableTemplates();
  const [open, setOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [strictness, setStrictness] = useState<'minimal' | 'balanced' | 'maximal'>('balanced');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadContent, setUploadContent] = useState('');
  const [uploadFormat, setUploadFormat] = useState<'yaml' | 'json'>('yaml');
  const [preview, setPreview] = useState<string>('');
  const [custom, setCustom] = useState<PendingEngrams['custom']>(undefined);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Staged, not stored. See PendingEngrams in engram-integration: there is no
  // job binding yet at selection time, so storing here always threw.
  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplate(templateId);
    onPendingChange?.({ templateId: templateId || undefined, custom });
    setMessage(templateId
      ? { type: 'success', text: 'Staged. Its instructions go to the node with your next order, and it is wiped when the job closes.' }
      : null);
  };

  const handleStrictnessChange = (level: 'minimal' | 'balanced' | 'maximal') => {
    setStrictness(level);
    onSanitizationChange?.(level);
  };

  const handleUpload = async () => {
    if (!uploadContent.trim()) {
      setMessage({ type: 'error', text: 'Paste engram content first.' });
      return;
    }
    const result = await parseUploadedEngram(uploadContent, uploadFormat);
    if (result.error) {
      setPreview('');
      setCustom(undefined);
      onPendingChange?.({ templateId: selectedTemplate || undefined, custom: undefined });
      setMessage({ type: 'error', text: result.error });
      return;
    }
    if (result.engram) {
      setPreview(
        'type: ' + result.engram.type +
        '\ndomain: ' + (result.engram.domain || 'general') +
        '\n\n' + result.engram.statement
      );
      setCustom(result.engram);
      onPendingChange?.({ templateId: selectedTemplate || undefined, custom: result.engram });
      setMessage({ type: 'success', text: 'Validated and staged. Its text goes to the node with your next order.' });
    }
  };

  const staged = (selectedTemplate ? 1 : 0) + (custom ? 1 : 0);
  const summary = staged > 0
    ? `privacy: ${strictness} · ${staged} engram${staged > 1 ? 's' : ''} staged`
    : `privacy: ${strictness}`;

  return (
    <div className="card engram">
      <button className="engram-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{open ? '▾' : '▸'} privacy and behavior</span>
        <span className="dim">{summary}</span>
      </button>

      {open && (
        <div className="engram-body">
          {message && (
            <div className={message.type === 'success' ? 'engram-ok' : 'engram-err'}>
              {message.text}
            </div>
          )}

          <label className="engram-label" htmlFor="engram-strictness">privacy protection level</label>
          <select
            id="engram-strictness"
            value={strictness}
            onChange={(e) => handleStrictnessChange(e.target.value as 'minimal' | 'balanced' | 'maximal')}
          >
            <option value="minimal">minimal</option>
            <option value="balanced">balanced (recommended)</option>
            <option value="maximal">maximal</option>
          </select>
          <p className="dim engram-note">{LEVEL_NOTE[strictness]}</p>
          <p className="dim engram-note">
            Sanitization runs in your browser, before the prompt is hashed and before it
            is sent. It is pattern matching and best effort, not a guarantee: accented
            and non-Latin names, homoglyphs and paraphrase get through. The chain sees a
            salted hash of your prompt plus your wallet address, permanently. The provider
            you pick receives the sanitized prompt in plaintext. Do not paste anything you
            would not show a stranger.
          </p>

          <label className="engram-label" htmlFor="engram-template">behavior template (optional, session-only)</label>
          <p className="dim engram-note">
            A behaviour template is an instruction, so it is prepended to your prompt and sent
            to the node in plaintext along with it. It is also part of what the on-chain hash
            commits to. A privacy template instead adds redaction rules and is applied locally.
          </p>
          <select
            id="engram-template"
            value={selectedTemplate}
            onChange={(e) => handleTemplateSelect(e.target.value)}
          >
            <option value="">none</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name} — {t.description}</option>
            ))}
          </select>

          <button className="engram-toggle" onClick={() => setShowUpload(s => !s)}>
            {showUpload ? '▾ custom engram' : '▸ custom engram (YAML or JSON)'}
          </button>

          {showUpload && (
            <div className="engram-upload">
              <div className="engram-formats">
                <label>
                  <input
                    type="radio"
                    value="yaml"
                    checked={uploadFormat === 'yaml'}
                    onChange={(e) => setUploadFormat(e.target.value as 'yaml' | 'json')}
                  />
                  YAML
                </label>
                <label>
                  <input
                    type="radio"
                    value="json"
                    checked={uploadFormat === 'json'}
                    onChange={(e) => setUploadFormat(e.target.value as 'yaml' | 'json')}
                  />
                  JSON
                </label>
              </div>
              <textarea
                value={uploadContent}
                onChange={(e) => setUploadContent(e.target.value)}
                placeholder={'type: behavioral\nstatement: When asked about food, structure the answer with ingredients, steps, and estimated time.'}
                rows={6}
              />
              <button onClick={handleUpload}>parse engram</button>
              {preview && <pre className="engram-preview">{preview}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default EngramSelector;
