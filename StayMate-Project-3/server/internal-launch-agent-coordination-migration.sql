-- Shared launch-board: multi-agent coordination.
-- Additive migration. It changes only internal_launch_* tables.

alter table public.internal_launch_tasks
  add column if not exists workflow_status text,
  add column if not exists assigned_agent text,
  add column if not exists completed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_agent_activity timestamptz,
  add column if not exists planned_files text[] not null default '{}'::text[],
  add column if not exists planned_scope text,
  add column if not exists agent_current_action text,
  add column if not exists commit_sha text;

update public.internal_launch_tasks
set workflow_status = case status
  when 'done' then 'done'
  when 'blocked' then 'owner_action'
  when 'work' then 'not_started'
  else 'not_started'
end
where workflow_status is null;

alter table public.internal_launch_tasks
  alter column workflow_status set default 'not_started';

alter table public.internal_launch_tasks
  add constraint internal_launch_tasks_workflow_status_check
  check (workflow_status in ('not_started','in_progress','waiting_verification','owner_action','done')) not valid;
alter table public.internal_launch_tasks
  validate constraint internal_launch_tasks_workflow_status_check;

alter table public.internal_launch_tasks
  add constraint internal_launch_tasks_assigned_agent_check
  check (assigned_agent is null or assigned_agent in ('codex','claude_code','owner','partner')) not valid;
alter table public.internal_launch_tasks
  validate constraint internal_launch_tasks_assigned_agent_check;

create table if not exists public.internal_launch_agent_activity (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.internal_launch_tasks(id) on delete cascade,
  happened_at timestamptz not null default now(),
  actor text not null,
  event_type text not null,
  message text not null default '',
  previous jsonb not null default '{}'::jsonb,
  current jsonb not null default '{}'::jsonb
);
create index if not exists internal_launch_agent_activity_task_time_idx
  on public.internal_launch_agent_activity(task_id, happened_at desc);

alter table public.internal_launch_agent_activity enable row level security;
create policy "internal launch admins read agent activity"
  on public.internal_launch_agent_activity for select to authenticated
  using (public.is_internal_launch_admin());

-- Agents use an ordinary authenticated Supabase session. This RPC is atomic:
-- it locks the requested task, rejects an existing assignee, and checks files
-- held by another active agent inside the same database transaction.
create or replace function public.internal_launch_claim_task(
  p_task_id text,
  p_agent text,
  p_planned_files text[] default '{}'::text[],
  p_planned_scope text default '',
  p_current_action text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_task public.internal_launch_tasks;
  v_conflict text;
begin
  if not public.is_internal_launch_admin() then
    return jsonb_build_object('code','ACCESS_DENIED');
  end if;
  if p_agent not in ('codex','claude_code') then
    return jsonb_build_object('code','INVALID_AGENT');
  end if;

  select * into v_task from public.internal_launch_tasks where id=p_task_id for update;
  if not found then return jsonb_build_object('code','TASK_NOT_FOUND'); end if;
  if v_task.assigned_agent is not null then
    return jsonb_build_object('code','TASK_ALREADY_CLAIMED','assigned_agent',v_task.assigned_agent);
  end if;
  if coalesce(v_task.workflow_status,'not_started') <> 'not_started' then
    return jsonb_build_object('code','TASK_NOT_AVAILABLE','workflow_status',v_task.workflow_status);
  end if;

  select t.id into v_conflict
  from public.internal_launch_tasks t
  where t.id <> p_task_id
    and t.assigned_agent is not null
    and t.assigned_agent <> p_agent
    and t.workflow_status in ('in_progress','waiting_verification','owner_action')
    and coalesce(t.planned_files,'{}'::text[]) && coalesce(p_planned_files,'{}'::text[])
  limit 1;
  if v_conflict is not null then
    return jsonb_build_object('code','FILE_CONFLICT','conflicting_task_id',v_conflict);
  end if;

  update public.internal_launch_tasks
  set assigned_agent=p_agent, workflow_status='in_progress', status='work',
      claimed_at=now(), last_agent_activity=now(),
      planned_files=coalesce(p_planned_files,'{}'::text[]),
      planned_scope=coalesce(p_planned_scope,''), agent_current_action=coalesce(p_current_action,'')
  where id=p_task_id;
  insert into public.internal_launch_agent_activity(task_id,actor,event_type,message,current)
  values(p_task_id,p_agent,'claimed',coalesce(p_current_action,'Задача взята в работу.'),
    jsonb_build_object('assigned_agent',p_agent,'planned_files',coalesce(p_planned_files,'{}'::text[])));
  return jsonb_build_object('code','CLAIM_SUCCESS','task_id',p_task_id,'assigned_agent',p_agent);
end;
$$;

create or replace function public.internal_launch_agent_update(
  p_task_id text, p_agent text, p_workflow_status text,
  p_current_action text default '', p_commit_sha text default null
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $$
declare v_task public.internal_launch_tasks;
begin
  if not public.is_internal_launch_admin() then return jsonb_build_object('code','ACCESS_DENIED'); end if;
  select * into v_task from public.internal_launch_tasks where id=p_task_id for update;
  if not found then return jsonb_build_object('code','TASK_NOT_FOUND'); end if;
  if v_task.assigned_agent is distinct from p_agent then return jsonb_build_object('code','NOT_TASK_ASSIGNEE'); end if;
  if p_workflow_status not in ('in_progress','waiting_verification','owner_action','done') then return jsonb_build_object('code','INVALID_STATUS'); end if;
  update public.internal_launch_tasks
  set workflow_status=p_workflow_status,
      status=case p_workflow_status when 'done' then 'done' when 'owner_action' then 'blocked' else 'work' end,
      owner_action=(p_workflow_status='owner_action'),
      completed_by=case when p_workflow_status='done' then p_agent else completed_by end,
      last_agent_activity=now(), agent_current_action=coalesce(p_current_action,agent_current_action),
      commit_sha=coalesce(p_commit_sha,commit_sha)
  where id=p_task_id;
  insert into public.internal_launch_agent_activity(task_id,actor,event_type,message,current)
  values(p_task_id,p_agent,p_workflow_status,coalesce(p_current_action,'Статус задачи обновлён.'),
    jsonb_build_object('workflow_status',p_workflow_status,'commit_sha',p_commit_sha));
  return jsonb_build_object('code','UPDATE_SUCCESS');
end;
$$;

create or replace function public.internal_launch_owner_assign(
  p_task_id text, p_agent text default null, p_workflow_status text default 'not_started',
  p_message text default ''
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $$
declare v_old jsonb;
begin
  if not public.is_internal_launch_admin() then return jsonb_build_object('code','ACCESS_DENIED'); end if;
  if p_agent is not null and p_agent not in ('codex','claude_code','owner','partner') then return jsonb_build_object('code','INVALID_AGENT'); end if;
  if p_workflow_status not in ('not_started','in_progress','waiting_verification','owner_action','done') then return jsonb_build_object('code','INVALID_STATUS'); end if;
  select jsonb_build_object('assigned_agent',assigned_agent,'workflow_status',workflow_status) into v_old
  from public.internal_launch_tasks where id=p_task_id for update;
  if v_old is null then return jsonb_build_object('code','TASK_NOT_FOUND'); end if;
  update public.internal_launch_tasks
  set assigned_agent=p_agent, workflow_status=p_workflow_status,
      status=case p_workflow_status when 'done' then 'done' when 'owner_action' then 'blocked' when 'not_started' then 'todo' else 'work' end,
      owner_action=(p_workflow_status='owner_action'),
      claimed_at=case when p_agent is null then null else now() end,
      last_agent_activity=now(),
      planned_files=case when p_agent is null then '{}'::text[] else planned_files end
  where id=p_task_id;
  insert into public.internal_launch_agent_activity(task_id,actor,event_type,message,previous,current)
  values(p_task_id,'owner','reassigned',coalesce(p_message,'Назначение изменено владельцем.'),v_old,
    jsonb_build_object('assigned_agent',p_agent,'workflow_status',p_workflow_status));
  return jsonb_build_object('code','OWNER_ASSIGN_SUCCESS');
end;
$$;

revoke all on function public.internal_launch_claim_task(text,text,text[],text,text) from public;
revoke all on function public.internal_launch_agent_update(text,text,text,text,text) from public;
revoke all on function public.internal_launch_owner_assign(text,text,text,text) from public;
grant execute on function public.internal_launch_claim_task(text,text,text[],text,text) to authenticated;
grant execute on function public.internal_launch_agent_update(text,text,text,text,text) to authenticated;
grant execute on function public.internal_launch_owner_assign(text,text,text,text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='internal_launch_agent_activity'
  ) then
    alter publication supabase_realtime add table public.internal_launch_agent_activity;
  end if;
end $$;
