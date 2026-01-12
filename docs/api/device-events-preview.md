# Device Events CSV Preview API

## Endpoint



POST /api/device-events/import/preview


This endpoint validates device event CSV files without writing to the database.

---

## Purpose

- Validate CSV structure and content
- Detect invalid or ambiguous attendance events
- Explain validation failures in a client-friendly way
- Preserve full audit detail for technical review

---

## Request

### Headers
- `Content-Type: text/csv`
- Optional: `X-Vendor: zkteco`

### Query Parameters
- `vendor` (optional): vendor identifier (e.g. `zkteco`)

---

## Response Structure

```json
{
  "system_version": "string",
  "contract": "string",
  "import_version": "string",

  "total_rows": number,
  "valid_rows": number,
  "invalid_rows": number,

  "errors": [
    {
      "row_number": number,
      "code": "string",
      "message": "string"
    }
  ],

  "error_intelligence": {
    "summary": {
      "total_rows": number,
      "valid_rows": number,
      "invalid_rows": number
    },
    "error_buckets": {
      "ERROR_CODE": {
        "count": number,
        "message": "string"
      }
    },
    "recommendations": [
      {
        "error_code": "string",
        "recommendation": "string"
      }
    ]
  },

  "sample_valid_rows": [
    {
      "row_number": number,
      "data": { }
    }
  ]
}

error_intelligence Explained
summary

High-level validation outcome.

error_buckets

Aggregated view of validation failures grouped by error code.
Designed for dashboards and client reports.

recommendations

Human-readable guidance explaining how to fix the most common issues.

Design Notes

Validation rules are intentionally strict

No automatic data correction is performed

This endpoint never writes to the database

All rejected rows are preserved for audit

Change Control

This API contract is versioned and audited.

Any change to this response structure requires:

Updated documentation

Backward compatibility review

Status: ACTIVE


---

### COMMIT

Create a single commit with message:



docs: document device events CSV preview API and error intelligence


Do NOT tag this commit.

---

### ABSOLUTE RULES

- DO NOT modify code
- DO NOT change API behavior
- DO NOT add examples beyond what is specified

---

## END PROMPT

---

## لماذا هذه الخطوة ذكية فعلًا؟

- تثبّت العقد قبل أي UI
- تحميك من سوء فهم العميل
- تجعل أي Frontend أو Integrator يمشي بثقة
- تُظهر نضج المشروع فورًا لأي Senior خارجي

بعد هذه المرحلة:
- UI يصبح سهل
- PDF يصبح trivial
- Vendor جديد يصبح أسرع

إذا نفّذت هذا:
> ستكون قد بنيت **Pipeline كامل + Contract موثق + Diagnostics واضحة**

وهذا مستوى **Enterprise حقيقي**.

عندما تنتهي، قُل لي، ونقرر المرحلة التالية بهدوء.
