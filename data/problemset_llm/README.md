# problemset_llm

Generated problem records from `Problems/urls.txt`.

Use:

```sh
OPENAI_API_KEY=... python3 scripts/annotate_problem_urls.py --limit 20
```

Trial run:

```sh
python3 scripts/annotate_problem_urls.py \
  --sample-one-per-platform \
  --out data/problemset_llm_trial \
  --overwrite \
  --insecure-ssl
```

The URL list is the source of truth for `source_url` and `source_topic`.
The LLM should only produce the normalized `statement`, `tags`, and `patterns`.

The script loads root `.env` and accepts either `OPENAI_API_KEY` or `OPEN_AI_API`.

Platform-specific runs:

```sh
python3 scripts/annotate_problem_urls.py --platform leetcode --out data/problemset_llm --insecure-ssl
python3 scripts/annotate_problem_urls.py --platform cses --out data/problemset_llm --insecure-ssl
python3 scripts/annotate_problem_urls.py --platform codeforces --out data/problemset_llm --insecure-ssl
```

On macOS, keep the machine awake during long runs:

```sh
caffeinate -dimsu python3 scripts/annotate_problem_urls.py --platform leetcode --out data/problemset_llm --insecure-ssl
```

Codeforces pages are often Cloudflare-blocked. The script skips entries without
usable statement text unless `--allow-metadata-only` is passed.
