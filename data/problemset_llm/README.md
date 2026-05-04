# problemset_llm

Generated problem records from `Problems/urls.txt`.

Use:

```sh
OPENAI_API_KEY=... python3 scripts/annotate_problem_urls.py --limit 20
```

The URL list is the source of truth for `source_url` and `source_topic`.
The LLM should only produce the normalized `statement`, `tags`, and `patterns`.
