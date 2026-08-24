import { useState, useEffect } from 'react';
import { getAvailableTemplates, loadCommunityTemplate } from '../lib/engram-integration';
import { parseUploadedEngram } from '../lib/engram-library';

interface EngramSelectorProps {
  onSanitizationChange?: (strictness: 'minimal' | 'balanced' | 'maximal') => void;
}

export function EngramSelector({ onSanitizationChange }: EngramSelectorProps) {
  const [templates, setTemplates] = useState<Array<{
    id: string;
    name: string;
    description: string;
    domain: string;
  }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [strictness, setStrictness] = useState<'minimal' | 'balanced' | 'maximal'>('balanced');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadContent, setUploadContent] = useState('');
  const [uploadFormat, setUploadFormat] = useState<'yaml' | 'json'>('yaml');
  const [preview, setPreview] = useState<string>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setTemplates(getAvailableTemplates());
  }, []);

  const handleTemplateSelect = async (templateId: string) => {
    if (!templateId) return;
    try {
      await loadCommunityTemplate(templateId);
      setSelectedTemplate(templateId);
      setMessage({ type: 'success', text: 'Template loaded for this session only. It will be wiped when the job closes.' });
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to load template: ' + String(err) });
    }
  };

  const handleStrictnessChange = (level: 'minimal' | 'balanced' | 'maximal') => {
    setStrictness(level);
    onSanitizationChange?.(level);
  };

  const handleUpload = async () => {
    if (!uploadContent.trim()) {
      setMessage({ type: 'error', text: 'Please enter engram content first.' });
      return;
    }

    const result = await parseUploadedEngram(uploadContent, uploadFormat);

    if (result.error) {
      setMessage({ type: 'error', text: result.error });
      return;
    }

    if (result.engram) {
      setPreview('Type: ' + result.engram.type + '\nDomain: ' + (result.engram.domain || 'general') + '\n\n' + result.engram.statement);
      setMessage({ type: 'success', text: 'Engram parsed and validated. It will be stored ephemerally when the job opens.' });
    }
  };

  return (
    <div style={{
      padding: '1rem',
      border: '1px solid #ddd',
      borderRadius: '8px',
      marginBottom: '1rem',
      background: '#f9f9f9'
    }}>
      <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem' }}>
        Privacy and Behavior Settings
      </h3>

      {message && (
        <div style={{
          padding: '0.5rem',
          marginBottom: '1rem',
          borderRadius: '4px',
          background: message.type === 'success' ? '#d4edda' : '#f8d7da',
          color: message.type === 'success' ? '#155724' : '#721c24'
        }}>
          {message.text}
        </div>
      )}

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>
          Privacy Protection Level
        </label>
        <select
          value={strictness}
          onChange={(e) => handleStrictnessChange(e.target.value as 'minimal' | 'balanced' | 'maximal')}
          style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
        >
          <option value="minimal">Minimal (emails, phones, cards only)</option>
          <option value="balanced">Balanced (recommended)</option>
          <option value="maximal">Maximal (aggressive PII removal)</option>
        </select>
        <p style={{ fontSize: '0.85rem', color: '#666', margin: '0.5rem 0 0 0' }}>
          Sanitization runs entirely in your browser. Providers and the chain never see raw personal data.
        </p>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '0.5rem' }}>
          Behavior Templates (optional, session-only)
        </label>
        <select
          value={selectedTemplate}
          onChange={(e) => handleTemplateSelect(e.target.value)}
          style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #ccc' }}
        >
          <option value="">Select a template...</option>
          {templates.map(t => (
            <option key={t.id} value={t.id}>
              {t.name} - {t.description}
            </option>
          ))}
        </select>
      </div>

      <div>
        <button
          onClick={() => setShowUpload(!showUpload)}
          style={{
            padding: '0.5rem 1rem',
            background: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            width: '100%'
          }}
        >
          {showUpload ? 'Hide Upload' : 'Upload Custom Engram (YAML or JSON)'}
        </button>

        {showUpload && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ marginBottom: '0.5rem' }}>
              <label>
                <input
                  type="radio"
                  value="yaml"
                  checked={uploadFormat === 'yaml'}
                  onChange={(e) => setUploadFormat(e.target.value as 'yaml' | 'json')}
                  style={{ marginRight: '0.5rem' }}
                />
                YAML
              </label>
              <label style={{ marginLeft: '1rem' }}>
                <input
                  type="radio"
                  value="json"
                  checked={uploadFormat === 'json'}
                  onChange={(e) => setUploadFormat(e.target.value as 'yaml' | 'json')}
                  style={{ marginRight: '0.5rem' }}
                />
                JSON
              </label>
            </div>
            <textarea
              value={uploadContent}
              onChange={(e) => setUploadContent(e.target.value)}
              placeholder={'type: behavioral\nstatement: When asked about food, structure the answer with ingredients, steps, and estimated time. Always confirm dietary restrictions first before giving a full recipe to the user.'}
              rows={6}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontFamily: 'monospace',
                fontSize: '0.85rem'
              }}
            />
            <button
              onClick={handleUpload}
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 1rem',
                background: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Parse Engram
            </button>

            {preview && (
              <div style={{
                marginTop: '1rem',
                padding: '0.5rem',
                background: '#e9ecef',
                borderRadius: '4px',
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
                fontSize: '0.85rem'
              }}>
                {preview}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default EngramSelector;
