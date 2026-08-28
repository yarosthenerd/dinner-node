"""Does prefill get reused across an agent's steps?

This is the measurement that decides whether long context is serveable here.
An agent sends a large, near-identical context on every step and changes only
the tail. If llama.cpp reuses the KV cache for the shared prefix, the second
step pays almost no prefill and free input becomes defensible. If it re-reads
the whole prompt each time, a 164:1 agent workload costs full prefill per step
and long context is unsellable on this hardware at any price.

Three calls, same num_ctx so no reload is triggered:
  1. cold      long prompt
  2. identical same prompt again
  3. extended  same prefix, different tail, which is the real agent shape
"""
import json, urllib.request, time

MODEL = "qwen3.6:35b-a3b"
FILLER = ("The provider settles per token against an escrow held on chain, and "
          "the checkpoint chain binds the amount charged to the exact text "
          "produced by the node that produced it. ")
PREFIX = FILLER * int(12000 / 34)

def call(prompt, num_ctx=16384, predict=32):
    body = {"model": MODEL, "prompt": prompt, "stream": False,
            "options": {"num_predict": predict, "num_ctx": num_ctx, "temperature": 0}}
    t = time.time()
    r = urllib.request.urlopen(urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=json.dumps(body).encode(), headers={"content-type": "application/json"}),
        timeout=1800)
    d = json.load(r)
    ped = d.get("prompt_eval_duration", 0)
    return {"prompt_tokens": d.get("prompt_eval_count", 0),
            "prefill_s": round(ped / 1e9, 2),
            "load_s": round(d.get("load_duration", 0) / 1e9, 2),
            "wall_s": round(time.time() - t, 1)}

for label, p in (("1 cold      ", PREFIX + "\n\nQ: Summarise the above in one line."),
                 ("2 identical ", PREFIX + "\n\nQ: Summarise the above in one line."),
                 ("3 same prefix, new tail", PREFIX + "\n\nQ: Now list two risks instead.")):
    print(label, json.dumps(call(p)), flush=True)
