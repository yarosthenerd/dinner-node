const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function* mock(prompt: string): AsyncGenerator<string> {
  const text = `Analyzing request "${prompt.slice(0, 60)}". This response is being served by idle hardware someone left on. Every token you read is a micropayment settling on Monad. At this rate the host machine funds its owner's dinner in roughly one streaming session. Proof: watch the settlement feed. `;
  for (const w of text.split(' ')) { yield w + ' '; await sleep(30); } // ~33 tok/s
}

export async function* ollama(prompt: string, model: string): AsyncGenerator<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true }),
  });
  for await (const line of res.body!.pipeThrough(new TextDecoderStream()) as any) {
    for (const l of line.split('\n')) if (l.trim()) {
      const j = JSON.parse(l); if (j.response) yield j.response;
    }
  }
}

export async function* openai(prompt: string, base: string, model: string): AsyncGenerator<string> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  for await (const line of res.body!.pipeThrough(new TextDecoderStream()) as any) {
    for (const l of line.split('\n')) if (l.startsWith('data: ') && l !== 'data: [DONE]') {
      const d = JSON.parse(l.slice(6)).choices?.[0]?.delta?.content; if (d) yield d;
    }
  }
}
