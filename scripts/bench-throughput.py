"""A1: prefill and generation throughput on the reference machine.

Measured through ollama directly rather than through the host, so the numbers
are the machine's and not the billing path's. num_predict is 128 at every
length: the market data says real agent outputs are short, so a long generation
would measure a shape nobody is buying.
"""
import json, urllib.request, time, sys

MODEL = "qwen3.6:35b-a3b"
FILLER = ("The provider settles per token against an escrow held on chain, and "
          "the checkpoint chain binds the amount charged to the exact text "
          "produced by the node that produced it. ")  # ~34 tokens per repeat

def prompt_of(target_tokens):
    reps = max(1, int(target_tokens / 34))
    return (FILLER * reps) + "\n\nIn one sentence, what does the text above describe?"

def run(target, num_ctx, predict=128):
    body = {"model": MODEL, "prompt": prompt_of(target), "stream": False,
            "options": {"num_predict": predict, "num_ctx": num_ctx, "temperature": 0}}
    t = time.time()
    try:
        r = urllib.request.urlopen(urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=json.dumps(body).encode(), headers={"content-type": "application/json"}),
            timeout=1800)
        d = json.load(r)
    except Exception as e:
        return {"target": target, "num_ctx": num_ctx, "error": str(e)[:200],
                "wall_s": round(time.time() - t, 1)}
    pe, ped = d.get("prompt_eval_count", 0), d.get("prompt_eval_duration", 0)
    ec, ed = d.get("eval_count", 0), d.get("eval_duration", 0)
    return {
        "target": target, "num_ctx": num_ctx,
        "prompt_tokens": pe,
        "prefill_s": round(ped / 1e9, 2),
        "prefill_tok_s": round(pe / (ped / 1e9), 1) if ped else None,
        "out_tokens": ec,
        "gen_s": round(ed / 1e9, 2),
        "gen_tok_s": round(ec / (ed / 1e9), 1) if ed else None,
        "load_s": round(d.get("load_duration", 0) / 1e9, 2),
        "ttft_s": round((d.get("load_duration", 0) + ped) / 1e9, 1),
        "wall_s": round(time.time() - t, 1),
    }

# num_ctx has to clear prompt + output. Stepping past 32768 is the whole
# question: REFRAME says we do not sell long input and CONTEXT_TOKENS is 32768,
# so 65k and 98k are the measurements that decide whether that is a choice or a
# hardware limit.
PLAN = [(512, 4096), (2000, 4096), (8000, 16384), (16000, 32768),
        (32000, 40960), (65000, 73728), (98000, 106496)]

out = open("a1-results.jsonl", "a")
for target, ctx in PLAN:
    r = run(target, ctx)
    print(json.dumps(r), flush=True)
    out.write(json.dumps(r) + "\n"); out.flush()
out.close()
