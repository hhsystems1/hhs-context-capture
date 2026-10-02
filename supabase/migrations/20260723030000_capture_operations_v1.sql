create schema capture_ops;

create table capture_ops.capture_operations (
  workspace_id text not null references memory_v1.workspaces(workspace_id),
  operation_id text not null,
  correlation_id text not null,
  platform text not null,
  opaque_account_reference text not null,
  opaque_conversation_reference text,
  operation_type text not null check (operation_type in ('capture','recapture','pairing')),
  source_component text not null check (source_component in (
    'extension_popup','extension_content','extension_worker','collector','archive','verifier','reconciler'
  )),
  status text not null check (status in (
    'created','pairing','prepared','capturing','delivering','archiving','verifying',
    'completed','needs_review','failed','interrupted','canceled'
  )),
  current_event_sequence integer not null default 0 check (current_event_sequence >= 0),
  last_event_type text,
  last_event_at timestamptz,
  last_successful_stage text not null default 'operation_created',
  safe_capture_reference text,
  archive_manifest_sha256 memory_v1.sha256,
  verification_status text check (verification_status in ('complete','needs_review','failed','partial')),
  stop_reason_code text,
  stop_summary text,
  retry_safe boolean not null default false,
  parent_operation_id text,
  schema_version text not null check (schema_version='hhs.capture-operation/1.0.0'),
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  terminal_at timestamptz,
  primary key (workspace_id,operation_id),
  unique (workspace_id,correlation_id),
  unique (workspace_id,idempotency_key),
  foreign key (workspace_id,parent_operation_id)
    references capture_ops.capture_operations(workspace_id,operation_id),
  check (parent_operation_id is null or parent_operation_id<>operation_id),
  check (operation_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$'),
  check (correlation_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$'),
  check (platform ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$'),
  check (opaque_account_reference ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$'),
  check (opaque_conversation_reference is null or opaque_conversation_reference ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$'),
  check (safe_capture_reference is null or safe_capture_reference ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  check (terminal_at is null or status in ('completed','needs_review','failed','interrupted','canceled'))
);

create table capture_ops.capture_operation_events (
  workspace_id text not null,
  operation_event_id text not null,
  operation_id text not null,
  correlation_id text not null,
  event_type text not null check (event_type in (
    'operation_created','pairing_requested','pairing_succeeded','pairing_failed',
    'identity_observed','identity_verified','identity_mismatch',
    'capture_requested','capture_started','capture_progress',
    'collector_delivery_started','collector_delivery_succeeded','collector_delivery_failed',
    'archive_started','archive_completed','verification_completed',
    'capture_completed','capture_needs_review','capture_failed','capture_interrupted','operation_canceled'
  )),
  event_sequence integer not null check (event_sequence > 0),
  event_timestamp timestamptz not null,
  operation_status text not null check (operation_status in (
    'created','pairing','prepared','capturing','delivering','archiving','verifying',
    'completed','needs_review','failed','interrupted','canceled'
  )),
  source_component text not null check (source_component in (
    'extension_popup','extension_content','extension_worker','collector','archive','verifier','reconciler'
  )),
  diagnostic_metadata jsonb not null default '{}'::jsonb,
  schema_version text not null check (schema_version='hhs.capture-operation-event/1.0.0'),
  event_sha256 memory_v1.sha256 not null,
  idempotency_key memory_v1.sha256 not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,operation_event_id),
  unique (workspace_id,operation_id,event_sequence),
  unique (workspace_id,idempotency_key),
  foreign key (workspace_id,operation_id)
    references capture_ops.capture_operations(workspace_id,operation_id)
);

create table capture_ops.capture_operation_receipts (
  workspace_id text not null,
  operation_receipt_id text not null,
  operation_id text not null,
  operation_event_id text not null,
  receipt_relative_locator text not null,
  receipt_sha256 memory_v1.sha256 not null,
  manifest_sha256 memory_v1.sha256 not null,
  schema_version text not null check (schema_version='hhs.capture-operation-receipt/1.0.0'),
  idempotency_key memory_v1.sha256 not null,
  record_sha256 memory_v1.sha256 not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id,operation_receipt_id),
  unique (workspace_id,operation_event_id),
  unique (workspace_id,idempotency_key),
  foreign key (workspace_id,operation_id)
    references capture_ops.capture_operations(workspace_id,operation_id),
  foreign key (workspace_id,operation_event_id)
    references capture_ops.capture_operation_events(workspace_id,operation_event_id),
  check (receipt_relative_locator ~ '^events/[a-zA-Z0-9._/-]+$' and receipt_relative_locator !~ '(^|/)\.\.(/|$)')
);

create or replace function capture_ops.require_workspace(requested_workspace_id text) returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  if requested_workspace_id is null
    or requested_workspace_id<>current_setting('memory_v1.workspace_id',true) then
    raise exception using errcode='42501',message='capture operation workspace context is missing or mismatched';
  end if;
end $$;

create or replace function capture_ops.safe_metadata(metadata jsonb) returns boolean
language plpgsql immutable
set search_path = pg_catalog
as $$
declare key text; value jsonb; rendered text;
begin
  if metadata is null or jsonb_typeof(metadata)<>'object' then return false; end if;
  for key,value in select * from jsonb_each(metadata) loop
    if key not in (
      'stage','progress_current','progress_total','message_count','content_block_count',
      'safe_error_code','safe_error_summary','verification_status','delivery_receipt_sha256',
      'archive_manifest_sha256','safe_capture_reference','reason_code','timeout_seconds',
      'last_successful_stage','identity_verified','archive_created','retry_safe'
    ) then return false; end if;
    if jsonb_typeof(value) not in ('string','number','boolean','null') then return false; end if;
    if key in ('progress_current','progress_total','message_count','content_block_count','timeout_seconds')
      and (jsonb_typeof(value)<>'number' or (value #>> '{}')::numeric<0 or trunc((value #>> '{}')::numeric)<>(value #>> '{}')::numeric) then return false; end if;
    if key in ('identity_verified','archive_created','retry_safe') and jsonb_typeof(value)<>'boolean' then return false; end if;
    if key in ('delivery_receipt_sha256','archive_manifest_sha256')
      and (jsonb_typeof(value)<>'string' or value #>> '{}' !~ '^[a-f0-9]{64}$') then return false; end if;
    if jsonb_typeof(value)='string' then
      rendered:=value #>> '{}';
      if length(rendered)>240 or rendered ~ '[\r\n]' then return false; end if;
      if rendered ~* '^[a-z]:[\\/]|^\\\\|/(users|home|var|etc)/' then return false; end if;
      if rendered ~* '(https?|file|postgres(ql)?):\/\/' then return false; end if;
      if rendered ~* '(authorization|bearer|password|pairing secret|collector token|cookie|private key|transcript|<html|<body)' then return false; end if;
    end if;
  end loop;
  return true;
end $$;

create or replace function capture_ops.next_status(current_status text,event_name text,current_sequence integer) returns text
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if current_status in ('completed','needs_review','failed','interrupted','canceled') then
    raise exception using errcode='55000',message='terminal capture operations cannot accept additional events';
  end if;
  if event_name='operation_created' and current_sequence=0 and current_status='created' then return 'created';
  elsif event_name='pairing_requested' and current_status='created' then return 'pairing';
  elsif event_name='pairing_succeeded' and current_status='pairing' then return 'prepared';
  elsif event_name='pairing_failed' and current_status='pairing' then return 'failed';
  elsif event_name='identity_observed' and current_status in ('created','prepared') then return 'prepared';
  elsif event_name='identity_verified' and current_status='prepared' then return 'prepared';
  elsif event_name='identity_mismatch' and current_status in ('created','prepared','capturing') then return 'failed';
  elsif event_name='capture_requested' and current_status in ('created','prepared') then return 'prepared';
  elsif event_name='capture_started' and current_status='prepared' then return 'capturing';
  elsif event_name='capture_progress' and current_status='capturing' then return 'capturing';
  elsif event_name='collector_delivery_started' and current_status='capturing' then return 'delivering';
  elsif event_name='collector_delivery_succeeded' and current_status='delivering' then return 'delivering';
  elsif event_name='collector_delivery_failed' and current_status in ('capturing','delivering') then return 'failed';
  elsif event_name='archive_started' and current_status='delivering' then return 'archiving';
  elsif event_name='archive_completed' and current_status='archiving' then return 'archiving';
  elsif event_name='verification_completed' and current_status='archiving' then return 'verifying';
  elsif event_name='capture_completed' and current_status='verifying' then return 'completed';
  elsif event_name='capture_needs_review' and current_status='verifying' then return 'needs_review';
  elsif event_name='capture_failed' and current_status in ('created','pairing','prepared','capturing','delivering','archiving','verifying') then return 'failed';
  elsif event_name='capture_interrupted' and current_status in ('created','pairing','prepared','capturing','delivering','archiving','verifying') then return 'interrupted';
  elsif event_name='operation_canceled' and current_status in ('created','pairing','prepared','capturing','delivering','archiving','verifying') then return 'canceled';
  end if;
  raise exception using errcode='23514',message=format('invalid capture operation transition: %s -> %s',current_status,event_name);
end $$;

create or replace function capture_ops.event_hash(
  requested_workspace_id text,requested_operation_id text,requested_correlation_id text,
  requested_event_type text,requested_event_sequence integer,requested_event_timestamp timestamptz,
  requested_status text,requested_source_component text,requested_metadata jsonb,
  requested_schema_version text,requested_idempotency_key text
) returns memory_v1.sha256
language sql immutable
set search_path = extensions,pg_catalog
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'workspace_id',requested_workspace_id,
    'operation_id',requested_operation_id,
    'correlation_id',requested_correlation_id,
    'event_type',requested_event_type,
    'event_sequence',requested_event_sequence,
    'event_timestamp',to_char(requested_event_timestamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'operation_status',requested_status,
    'source_component',requested_source_component,
    'diagnostic_metadata',requested_metadata,
    'schema_version',requested_schema_version,
    'idempotency_key',requested_idempotency_key
  )::text,'UTF8'),'sha256'),'hex')::memory_v1.sha256
$$;

create or replace function capture_ops.guard_operation_transition() returns trigger
language plpgsql
set search_path = capture_ops,pg_catalog
as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='capture operations cannot be deleted'; end if;
  if new.workspace_id<>old.workspace_id or new.operation_id<>old.operation_id
    or new.correlation_id<>old.correlation_id or new.platform<>old.platform
    or new.opaque_account_reference<>old.opaque_account_reference
    or new.opaque_conversation_reference is distinct from old.opaque_conversation_reference
    or new.operation_type<>old.operation_type or new.source_component<>old.source_component
    or new.parent_operation_id is distinct from old.parent_operation_id
    or new.schema_version<>old.schema_version or new.idempotency_key<>old.idempotency_key
    or new.record_sha256<>old.record_sha256 or new.created_at<>old.created_at then
    raise exception using errcode='55000',message='capture operation identity and lineage are immutable';
  end if;
  if new.current_event_sequence<>old.current_event_sequence+1
    or new.last_event_type is null or new.last_event_at is null or new.updated_at<old.updated_at then
    raise exception using errcode='23514',message='capture operation updates require exactly one appended event';
  end if;
  if new.status<>capture_ops.next_status(old.status,new.last_event_type,old.current_event_sequence) then
    raise exception using errcode='23514',message='capture operation status does not match its appended event';
  end if;
  if old.safe_capture_reference is not null and new.safe_capture_reference is distinct from old.safe_capture_reference then
    raise exception using errcode='55000',message='safe capture reference cannot change';
  end if;
  if old.archive_manifest_sha256 is not null and new.archive_manifest_sha256 is distinct from old.archive_manifest_sha256 then
    raise exception using errcode='55000',message='archive manifest hash cannot change';
  end if;
  return new;
end $$;
create trigger capture_operation_transition_guard before update or delete on capture_ops.capture_operations
  for each row execute function capture_ops.guard_operation_transition();

create trigger immutable_event_guard before update or delete on capture_ops.capture_operation_events
  for each row execute function memory_v1.guard_immutable_row();
create trigger immutable_receipt_guard before update or delete on capture_ops.capture_operation_receipts
  for each row execute function memory_v1.guard_immutable_row();

create or replace function capture_ops.append_operation_event(
  requested_workspace_id text,requested_operation_id text,requested_correlation_id text,
  requested_event_type text,requested_event_sequence integer,requested_event_timestamp timestamptz,
  requested_source_component text,requested_metadata jsonb,requested_schema_version text,
  requested_idempotency_key memory_v1.sha256,submitted_event_sha256 memory_v1.sha256 default null
) returns table(operation_event_id text,event_sha256 memory_v1.sha256,operation_status text,replayed boolean)
language plpgsql security definer
set search_path = capture_ops,memory_v1,extensions,pg_catalog
as $$
declare op capture_ops.capture_operations%rowtype; next_state text; computed_hash memory_v1.sha256;
  existing capture_ops.capture_operation_events%rowtype; generated_event_id text;
begin
  perform capture_ops.require_workspace(requested_workspace_id);
  if requested_event_sequence<1 then raise exception using errcode='23514',message='event sequence must be positive'; end if;
  if requested_schema_version<>'hhs.capture-operation-event/1.0.0' then raise exception using errcode='23514',message='unsupported operation event schema'; end if;
  if not capture_ops.safe_metadata(requested_metadata) then raise exception using errcode='23514',message='diagnostic metadata failed the privacy allowlist'; end if;
  select * into op from capture_ops.capture_operations
    where workspace_id=requested_workspace_id and operation_id=requested_operation_id for update;
  if not found then raise exception using errcode='23503',message='capture operation does not exist'; end if;
  if op.correlation_id<>requested_correlation_id then raise exception using errcode='23514',message='operation correlation identity mismatch'; end if;
  select * into existing from capture_ops.capture_operation_events
    where workspace_id=requested_workspace_id and operation_id=requested_operation_id
      and event_sequence=requested_event_sequence;
  if found then
    computed_hash:=capture_ops.event_hash(
      requested_workspace_id,requested_operation_id,requested_correlation_id,requested_event_type,
      requested_event_sequence,requested_event_timestamp,existing.operation_status,requested_source_component,
      requested_metadata,requested_schema_version,requested_idempotency_key
    );
    if submitted_event_sha256 is not null and submitted_event_sha256<>computed_hash then
      raise exception using errcode='23514',message='operation event SHA-256 mismatch';
    end if;
    if existing.event_sha256<>computed_hash or existing.idempotency_key<>requested_idempotency_key then
      raise exception using errcode='23505',message='operation event sequence conflicts with immutable history';
    end if;
    return query select existing.operation_event_id,existing.event_sha256,existing.operation_status,true;
    return;
  end if;
  next_state:=capture_ops.next_status(op.status,requested_event_type,op.current_event_sequence);
  computed_hash:=capture_ops.event_hash(
    requested_workspace_id,requested_operation_id,requested_correlation_id,requested_event_type,
    requested_event_sequence,requested_event_timestamp,next_state,requested_source_component,
    requested_metadata,requested_schema_version,requested_idempotency_key
  );
  if submitted_event_sha256 is not null and submitted_event_sha256<>computed_hash then
    raise exception using errcode='23514',message='operation event SHA-256 mismatch';
  end if;
  if requested_event_sequence<>op.current_event_sequence+1 then
    raise exception using errcode='23514',message=format('out-of-order operation event: expected %s received %s',op.current_event_sequence+1,requested_event_sequence);
  end if;
  if op.last_event_at is not null and requested_event_timestamp<op.last_event_at then
    raise exception using errcode='23514',message='operation event timestamp moved backward';
  end if;
  if requested_event_timestamp>now()+interval '5 minutes' then
    raise exception using errcode='23514',message='operation event timestamp is too far in the future';
  end if;
  generated_event_id:='operation_event_' || substr(encode(extensions.digest(convert_to(
    requested_workspace_id || ':' || requested_operation_id || ':' || requested_event_sequence::text,
    'UTF8'),'sha256'),'hex'),1,32);
  insert into capture_ops.capture_operation_events (
    workspace_id,operation_event_id,operation_id,correlation_id,event_type,event_sequence,event_timestamp,
    operation_status,source_component,diagnostic_metadata,schema_version,event_sha256,idempotency_key
  ) values (
    requested_workspace_id,generated_event_id,requested_operation_id,requested_correlation_id,requested_event_type,
    requested_event_sequence,requested_event_timestamp,next_state,requested_source_component,requested_metadata,
    requested_schema_version,computed_hash,requested_idempotency_key
  );
  update capture_ops.capture_operations set
    status=next_state,current_event_sequence=requested_event_sequence,last_event_type=requested_event_type,
    last_event_at=requested_event_timestamp,
    last_successful_stage=case when next_state in ('failed','interrupted','canceled')
      then last_successful_stage else coalesce(requested_metadata->>'last_successful_stage',requested_metadata->>'stage',requested_event_type) end,
    safe_capture_reference=coalesce(safe_capture_reference,requested_metadata->>'safe_capture_reference'),
    archive_manifest_sha256=coalesce(archive_manifest_sha256,(requested_metadata->>'archive_manifest_sha256')::memory_v1.sha256),
    verification_status=coalesce(requested_metadata->>'verification_status',verification_status),
    stop_reason_code=case when next_state in ('failed','interrupted','canceled') then coalesce(requested_metadata->>'reason_code',requested_metadata->>'safe_error_code') else stop_reason_code end,
    stop_summary=case when next_state in ('failed','interrupted','canceled') then requested_metadata->>'safe_error_summary' else stop_summary end,
    retry_safe=next_state in ('failed','interrupted','canceled'),
    updated_at=requested_event_timestamp,
    terminal_at=case when next_state in ('completed','needs_review','failed','interrupted','canceled') then requested_event_timestamp else null end
    where workspace_id=requested_workspace_id and operation_id=requested_operation_id;
  return query select generated_event_id,computed_hash,next_state,false;
end $$;

create or replace function capture_ops.create_capture_operation(
  requested_workspace_id text,requested_operation_id text,requested_correlation_id text,
  requested_platform text,requested_account_reference text,requested_conversation_reference text,
  requested_operation_type text,requested_source_component text,requested_parent_operation_id text,
  requested_created_at timestamptz,requested_idempotency_key memory_v1.sha256,
  requested_event_idempotency_key memory_v1.sha256
) returns text
language plpgsql security definer
set search_path = capture_ops,memory_v1,extensions,pg_catalog
as $$
declare parent_status text; existing_hash memory_v1.sha256; body_hash memory_v1.sha256;
begin
  perform capture_ops.require_workspace(requested_workspace_id);
  if requested_operation_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$'
    or requested_correlation_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,127}$'
    or requested_platform !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$'
    or requested_account_reference !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$'
    or (requested_conversation_reference is not null and requested_conversation_reference !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,255}$') then
    raise exception using errcode='23514',message='capture operation identity is malformed';
  end if;
  if requested_operation_type not in ('capture','recapture','pairing') then raise exception using errcode='23514',message='invalid capture operation type'; end if;
  if requested_source_component not in ('extension_popup','extension_content','extension_worker','collector','archive','verifier','reconciler') then raise exception using errcode='23514',message='invalid source component'; end if;
  if requested_parent_operation_id is not null then
    select status into parent_status from capture_ops.capture_operations
      where workspace_id=requested_workspace_id and operation_id=requested_parent_operation_id;
    if parent_status not in ('failed','interrupted','canceled') then
      raise exception using errcode='23514',message='retry parent must be terminal and safely retryable';
    end if;
  end if;
  body_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
    'workspace_id',requested_workspace_id,'operation_id',requested_operation_id,
    'correlation_id',requested_correlation_id,'platform',requested_platform,
    'opaque_account_reference',requested_account_reference,
    'opaque_conversation_reference',requested_conversation_reference,
    'operation_type',requested_operation_type,'source_component',requested_source_component,
    'parent_operation_id',requested_parent_operation_id,'schema_version','hhs.capture-operation/1.0.0',
    'idempotency_key',requested_idempotency_key
  )::text,'UTF8'),'sha256'),'hex');
  select record_sha256 into existing_hash from capture_ops.capture_operations
    where workspace_id=requested_workspace_id and operation_id=requested_operation_id;
  if found then
    if existing_hash<>body_hash then raise exception using errcode='23505',message='capture operation identity collision'; end if;
    return requested_operation_id;
  end if;
  insert into capture_ops.capture_operations (
    workspace_id,operation_id,correlation_id,platform,opaque_account_reference,opaque_conversation_reference,
    operation_type,source_component,status,current_event_sequence,last_successful_stage,parent_operation_id,
    schema_version,idempotency_key,record_sha256,created_at,updated_at
  ) values (
    requested_workspace_id,requested_operation_id,requested_correlation_id,requested_platform,
    requested_account_reference,requested_conversation_reference,requested_operation_type,
    requested_source_component,'created',0,'operation_created',requested_parent_operation_id,
    'hhs.capture-operation/1.0.0',requested_idempotency_key,body_hash,requested_created_at,requested_created_at
  );
  perform capture_ops.append_operation_event(
    requested_workspace_id,requested_operation_id,requested_correlation_id,'operation_created',1,
    requested_created_at,requested_source_component,'{"stage":"operation_created"}'::jsonb,
    'hhs.capture-operation-event/1.0.0',requested_event_idempotency_key,null
  );
  return requested_operation_id;
end $$;

create or replace function capture_ops.reconcile_interrupted_operation(
  requested_workspace_id text,requested_operation_id text,requested_at timestamptz,
  requested_timeout_seconds integer,requested_idempotency_key memory_v1.sha256
) returns text
language plpgsql security definer
set search_path = capture_ops,memory_v1,pg_catalog
as $$
declare op capture_ops.capture_operations%rowtype;
begin
  perform capture_ops.require_workspace(requested_workspace_id);
  if requested_timeout_seconds<60 then raise exception using errcode='23514',message='reconciliation timeout must be at least 60 seconds'; end if;
  select * into op from capture_ops.capture_operations
    where workspace_id=requested_workspace_id and operation_id=requested_operation_id for update;
  if not found then raise exception using errcode='23503',message='capture operation does not exist'; end if;
  if op.status in ('completed','needs_review','failed','interrupted','canceled') then
    raise exception using errcode='55000',message='terminal operation cannot be reconciled';
  end if;
  if requested_at-op.last_event_at<make_interval(secs=>requested_timeout_seconds) then
    raise exception using errcode='23514',message='operation is not stale enough to classify as interrupted';
  end if;
  perform capture_ops.append_operation_event(
    requested_workspace_id,op.operation_id,op.correlation_id,'capture_interrupted',
    op.current_event_sequence+1,requested_at,'reconciler',
    jsonb_build_object('reason_code','stale_timeout','safe_error_code','stale_timeout',
      'safe_error_summary','The operation stopped making progress and was classified as interrupted.',
      'timeout_seconds',requested_timeout_seconds,'last_successful_stage',op.last_successful_stage,'retry_safe',true),
    'hhs.capture-operation-event/1.0.0',requested_idempotency_key,null
  );
  return requested_operation_id;
end $$;

create or replace function capture_ops.register_operation_receipt(
  requested_workspace_id text,requested_receipt_id text,requested_operation_id text,
  requested_event_id text,requested_relative_locator text,requested_receipt_sha256 memory_v1.sha256,
  requested_manifest_sha256 memory_v1.sha256,requested_idempotency_key memory_v1.sha256,
  requested_record_sha256 memory_v1.sha256
) returns void
language plpgsql security definer
set search_path = capture_ops,pg_catalog
as $$
begin
  perform capture_ops.require_workspace(requested_workspace_id);
  insert into capture_ops.capture_operation_receipts (
    workspace_id,operation_receipt_id,operation_id,operation_event_id,receipt_relative_locator,
    receipt_sha256,manifest_sha256,schema_version,idempotency_key,record_sha256
  ) values (
    requested_workspace_id,requested_receipt_id,requested_operation_id,requested_event_id,requested_relative_locator,
    requested_receipt_sha256,requested_manifest_sha256,'hhs.capture-operation-receipt/1.0.0',
    requested_idempotency_key,requested_record_sha256
  ) on conflict (workspace_id,operation_event_id) do nothing;
end $$;

create view capture_ops.operation_status_report with (security_invoker=true) as
select o.workspace_id,o.operation_id,o.correlation_id,o.platform,o.operation_type,o.status,
  o.current_event_sequence as last_event_sequence,o.last_event_type,o.last_event_at,o.last_successful_stage,
  exists(select 1 from capture_ops.capture_operation_events e where e.workspace_id=o.workspace_id and e.operation_id=o.operation_id and e.event_type='capture_started') as capture_started,
  exists(select 1 from capture_ops.capture_operation_events e where e.workspace_id=o.workspace_id and e.operation_id=o.operation_id and e.event_type='identity_verified') as identity_verified,
  exists(select 1 from capture_ops.capture_operation_events e where e.workspace_id=o.workspace_id and e.operation_id=o.operation_id and e.event_type='collector_delivery_succeeded') as collector_delivery_succeeded,
  exists(select 1 from capture_ops.capture_operation_events e where e.workspace_id=o.workspace_id and e.operation_id=o.operation_id and e.event_type='archive_started') as archive_started,
  o.safe_capture_reference is not null as archive_created,o.safe_capture_reference,
  o.verification_status is not null as verification_finished,o.verification_status,
  o.stop_reason_code,o.stop_summary,o.retry_safe,o.parent_operation_id,
  (select child.operation_id from capture_ops.capture_operations child
    where child.workspace_id=o.workspace_id and child.parent_operation_id=o.operation_id
    order by child.created_at desc limit 1) as retry_operation_id,
  e.source_component as final_source_component,
  o.status not in ('completed','needs_review','failed','interrupted','canceled')
    and o.last_event_at<now()-interval '15 minutes' as stuck,
  o.created_at,o.updated_at,o.terminal_at
from capture_ops.capture_operations o
join capture_ops.capture_operation_events e
  on e.workspace_id=o.workspace_id and e.operation_id=o.operation_id and e.event_sequence=o.current_event_sequence;

create view capture_ops.latest_operation_report with (security_invoker=true) as
select distinct on (workspace_id) * from capture_ops.operation_status_report
order by workspace_id,created_at desc;

alter table capture_ops.capture_operations enable row level security;
alter table capture_ops.capture_operations force row level security;
alter table capture_ops.capture_operation_events enable row level security;
alter table capture_ops.capture_operation_events force row level security;
alter table capture_ops.capture_operation_receipts enable row level security;
alter table capture_ops.capture_operation_receipts force row level security;

create policy workspace_isolation on capture_ops.capture_operations
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));
create policy workspace_isolation on capture_ops.capture_operation_events
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));
create policy workspace_isolation on capture_ops.capture_operation_receipts
  using (workspace_id=current_setting('memory_v1.workspace_id',true))
  with check (workspace_id=current_setting('memory_v1.workspace_id',true));

create index capture_operations_status_idx on capture_ops.capture_operations(workspace_id,status,last_event_at desc);
create index capture_operations_parent_idx on capture_ops.capture_operations(workspace_id,parent_operation_id);
create index capture_operation_events_timeline_idx on capture_ops.capture_operation_events(workspace_id,operation_id,event_sequence);
create index capture_operation_receipts_operation_idx on capture_ops.capture_operation_receipts(workspace_id,operation_id);

revoke all on schema capture_ops from public;
revoke all on all tables in schema capture_ops from public;
revoke all on all functions in schema capture_ops from public;
grant usage on schema capture_ops to memory_v1_ingest_writer,memory_v1_report_reader;
grant select on capture_ops.capture_operations,capture_ops.capture_operation_events,
  capture_ops.capture_operation_receipts,capture_ops.operation_status_report,capture_ops.latest_operation_report
  to memory_v1_ingest_writer,memory_v1_report_reader;
grant execute on function capture_ops.create_capture_operation(
  text,text,text,text,text,text,text,text,text,timestamptz,memory_v1.sha256,memory_v1.sha256
) to memory_v1_ingest_writer;
grant execute on function capture_ops.append_operation_event(
  text,text,text,text,integer,timestamptz,text,jsonb,text,memory_v1.sha256,memory_v1.sha256
) to memory_v1_ingest_writer;
grant execute on function capture_ops.reconcile_interrupted_operation(
  text,text,timestamptz,integer,memory_v1.sha256
) to memory_v1_ingest_writer;
grant execute on function capture_ops.register_operation_receipt(
  text,text,text,text,text,memory_v1.sha256,memory_v1.sha256,memory_v1.sha256,memory_v1.sha256
) to memory_v1_ingest_writer;
