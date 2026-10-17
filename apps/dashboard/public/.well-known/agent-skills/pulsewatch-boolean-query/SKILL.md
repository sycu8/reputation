---
name: pulsewatch-boolean-query
description: Write PulseWatch Boolean listening queries with AND, OR, NOT, parentheses, and quoted phrases.
---

# PulseWatch Boolean queries

PulseWatch monitors store a Boolean query. The same syntax is checked by `POST /v1/queries/validate`.

## Syntax

- `AND`, `OR`, and `NOT` combine terms.
- Parentheses group expressions.
- Double quotes mark an exact phrase.
- Terms may include Unicode, including Vietnamese.

Example: `("OrangeCloud" OR PulseWatch) AND NOT hiring`

## Check before saving

```http
POST https://reputation.orangecloud.vn/api/v1/queries/validate
Content-Type: application/json

{"rawQuery":"(\"OrangeCloud\" OR PulseWatch) AND NOT hiring"}
```

A valid response has `valid` true plus `normalizedQuery` and `ast`. An invalid query returns `valid` false.
