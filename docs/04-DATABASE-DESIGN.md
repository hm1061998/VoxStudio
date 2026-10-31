# 04 — Database Design

Use PostgreSQL. Use UUID primary keys, UTC timestamps, foreign keys, indexes, and migrations. Store large audio binaries in object storage, not PostgreSQL.

## Tables

### users

- id UUID PK
- email CITEXT unique
- password_hash
- display_name
- status
- created_at, updated_at

### workspaces

- id UUID PK
- owner_user_id FK users
- name
- created_at, updated_at

### workspace_members (future-ready)

- workspace_id FK
- user_id FK
- role
- composite PK

### projects

- id UUID PK
- workspace_id FK
- name
- description nullable
- default_locale
- status
- revision integer
- created_at, updated_at, archived_at nullable

### project_segments

- id UUID PK
- project_id FK
- position integer
- source_text text
- locale varchar
- engine_id varchar
- voice_id varchar
- settings_json jsonb
- revision integer
- latest_audio_asset_id nullable
- created_at, updated_at
- unique(project_id, position)

### tts_engines

- id varchar PK
- display_name
- version
- synthesis_method
- compliance_status
- enabled boolean
- metadata_json jsonb
- license_id
- verified_at

### tts_voices

- id varchar PK
- engine_id FK
- display_name
- locale
- accent nullable
- voice_package_version
- license_id
- enabled boolean
- capabilities_json jsonb
- qa_status
- qa_report_json jsonb

### voice_presets

- id UUID PK
- workspace_id FK nullable (null = built-in)
- name
- description
- locale_scope nullable
- parameters_json jsonb
- is_builtin boolean
- created_at, updated_at

### pronunciation_entries

- id UUID PK
- workspace_id FK
- locale
- match_text
- replacement_text
- phoneme_format nullable
- engine_scope nullable
- case_sensitive boolean
- priority integer
- enabled boolean
- created_at, updated_at

### render_jobs

- id UUID PK
- project_id FK
- requested_by_user_id FK
- status
- progress_units integer
- total_units integer
- render_plan_json jsonb
- cache_key nullable
- error_code nullable
- error_message_safe nullable
- started_at, completed_at, created_at

### audio_assets

- id UUID PK
- workspace_id FK
- project_id FK
- segment_id FK nullable
- render_job_id FK nullable
- storage_key
- format
- codec
- sample_rate
- channels
- bit_depth nullable
- bitrate nullable
- duration_ms
- file_size_bytes
- checksum_sha256
- engine_snapshot_json
- dsp_snapshot_json
- created_at
- expires_at nullable

### project_versions

- id UUID PK
- project_id FK
- revision
- snapshot_json
- created_by_user_id FK
- created_at
- unique(project_id, revision)

### audit_events

- id UUID PK
- workspace_id FK
- actor_user_id FK nullable
- event_type
- resource_type
- resource_id
- metadata_json
- created_at

## Indexes

- users(email)
- workspaces(owner_user_id)
- projects(workspace_id, updated_at desc)
- project_segments(project_id, position)
- render_jobs(project_id, created_at desc)
- render_jobs(status, created_at)
- audio_assets(workspace_id, created_at desc)
- pronunciation_entries(workspace_id, locale, enabled)

## Data rules

- Delete project must either cascade metadata and schedule storage cleanup or soft-delete first; never orphan objects.
- Audio asset deletion must verify no active project/version references it.
- JSON settings must be validated against versioned schemas.
- Persist all timestamps in UTC; render and display localized times in the client.
- Use optimistic concurrency via revision/version fields.
- Store a render-plan snapshot for reproducibility.
