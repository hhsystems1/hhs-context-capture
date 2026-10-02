create or replace function capture_ops.safe_metadata(metadata jsonb) returns boolean
language plpgsql immutable
set search_path = pg_catalog
as $$
declare key text; value jsonb; rendered text; error_code text; expected_summary text;
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
    if key='verification_status' and (jsonb_typeof(value)<>'string' or value #>> '{}' not in ('complete','needs_review','failed','partial')) then return false; end if;
    if key='safe_capture_reference' and (jsonb_typeof(value)<>'string' or value #>> '{}' !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$') then return false; end if;
    if jsonb_typeof(value)='string' then
      rendered:=value #>> '{}';
      if length(rendered)>240 or rendered ~ '[\r\n]' then return false; end if;
      if rendered ~* '^[a-z]:[\\/]|^\\\\|/(users|home|var|etc)/' then return false; end if;
      if rendered ~* '(https?|file|postgres(ql)?):\/\/' then return false; end if;
      if rendered ~* '(authorization|bearer|password|pairing secret|collector token|cookie|private key|transcript|prompt content|response content|raw source|<html|<body)' then return false; end if;
    end if;
  end loop;
  if metadata ? 'safe_error_code' then
    error_code:=metadata->>'safe_error_code';
    expected_summary:=case error_code
      when 'pairing_failed' then 'The local collector did not accept the pairing request.'
      when 'identity_mismatch' then 'The active conversation identity changed or did not match.'
      when 'delivery_failed' then 'The capture could not be delivered to the local collector.'
      when 'archive_failed' then 'The collector could not finish the immutable archive.'
      when 'verification_failed' then 'Capture verification did not finish successfully.'
      when 'stream_interrupted' then 'The local capture stream stopped before completion.'
      when 'user_canceled' then 'The contributor canceled the operation.'
      when 'stale_timeout' then 'The operation stopped making progress and was classified as interrupted.'
      when 'collector_unavailable' then 'The local collector could not be reached.'
      when 'validation_failed' then 'The collector rejected invalid operation data.'
      when 'internal_error' then 'A local component reported a safe internal failure.'
      else null end;
    if expected_summary is null then return false; end if;
    if metadata ? 'safe_error_summary' and metadata->>'safe_error_summary'<>expected_summary then return false; end if;
  elsif metadata ? 'safe_error_summary' then return false;
  end if;
  return true;
end $$;
