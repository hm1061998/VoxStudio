import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type {
  EngineDto,
  JobEventDto,
  PresetDto,
  ProjectDto,
  ProjectSummaryDto,
  PronunciationEntryDto,
  RenderJobDto,
  VoiceProfileDto,
  VoiceDto,
} from '@voxstudio/contracts';
import { api } from './client';

export const qk = {
  projects: (ws: string, q: string, sort: string, archived: boolean) =>
    ['projects', ws, q, sort, archived] as const,
  project: (id: string) => ['project', id] as const,
  voices: (locale?: string) => ['voices', locale ?? ''] as const,
  voice: (id: string) => ['voice', id] as const,
  engines: ['engines'] as const,
  presets: ['presets'] as const,
  pronunciation: (q: string) => ['pronunciation', q] as const,
  jobs: (projectId: string) => ['jobs', projectId] as const,
  job: (id: string) => ['job', id] as const,
  recentJobs: ['recent-jobs'] as const,
};

export const useVoices = (locale?: string) =>
  useQuery({
    queryKey: qk.voices(locale),
    queryFn: () => api<VoiceDto[]>(`/voices${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`),
    staleTime: 60_000,
  });
export const useVoice = (id: string | null) =>
  useQuery({
    queryKey: qk.voice(id ?? ''),
    queryFn: () => api<VoiceProfileDto>(`/voices/${encodeURIComponent(id!)}/profile`),
    enabled: !!id,
    staleTime: 300_000,
  });
export const useEngines = () =>
  useQuery({ queryKey: qk.engines, queryFn: () => api<EngineDto[]>('/engines') });
export const usePresets = () =>
  useQuery({ queryKey: qk.presets, queryFn: () => api<PresetDto[]>('/presets') });
export const useProjects = (ws: string, q: string, sort: string, archived: boolean) =>
  useQuery({
    queryKey: qk.projects(ws, q, sort, archived),
    queryFn: () =>
      api<ProjectSummaryDto[]>(
        `/workspaces/${ws}/projects?sort=${sort}&archived=${archived}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    enabled: !!ws,
  });
export const useProject = (id: string) =>
  useQuery({
    queryKey: qk.project(id),
    queryFn: () => api<ProjectDto>(`/projects/${id}`),
    staleTime: Infinity,
  });
export const useProjectJobs = (id: string) =>
  useQuery({ queryKey: qk.jobs(id), queryFn: () => api<RenderJobDto[]>(`/projects/${id}/render-jobs`) });
export const useRecentJobs = () =>
  useQuery({ queryKey: qk.recentJobs, queryFn: () => api<RenderJobDto[]>('/render-jobs') });
export const usePronunciation = (q: string) =>
  useQuery({
    queryKey: qk.pronunciation(q),
    queryFn: () =>
      api<PronunciationEntryDto[]>(`/pronunciation-entries${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });

type Listener = (e: JobEventDto) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One shared SSE connection; events update job caches and notify subscribers. */
export function useJobEvents(onEvent?: Listener): void {
  const qc = useQueryClient();
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const l: Listener = (e) => ref.current?.(e);
    listeners.add(l);
    if (!source) {
      source = new EventSource('/api/v1/events/render-jobs');
      const handle = (msg: MessageEvent<string>) => {
        const e = JSON.parse(msg.data) as JobEventDto;
        qc.setQueryData(qk.job(e.job.id), e.job);
        qc.setQueryData<RenderJobDto[]>(qk.jobs(e.job.projectId), (old) => (old ? upsert(old, e.job) : old));
        qc.setQueryData<RenderJobDto[]>(qk.recentJobs, (old) =>
          old && e.job.kind === 'project' ? upsert(old, e.job) : old,
        );
        listeners.forEach((fn) => fn(e));
      };
      for (const t of [
        'job.queued',
        'job.started',
        'job.progress',
        'job.succeeded',
        'job.failed',
        'job.cancelled',
      ])
        source.addEventListener(t, handle as EventListener);
    }
    return () => {
      listeners.delete(l);
      if (!listeners.size && source) {
        source.close();
        source = null;
      }
    };
  }, [qc]);
}

function upsert(list: RenderJobDto[], job: RenderJobDto): RenderJobDto[] {
  const i = list.findIndex((j) => j.id === job.id);
  if (i === -1) return [job, ...list];
  const copy = [...list];
  copy[i] = job;
  return copy;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Resolve when a job reaches a terminal state (SSE first, polling as a fallback). */
export function waitForJob(job: RenderJobDto, signal?: AbortSignal): Promise<RenderJobDto> {
  if (TERMINAL.has(job.status)) return Promise.resolve(job);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (j: RenderJobDto) => {
      if (done) return;
      done = true;
      listeners.delete(l);
      clearInterval(poll);
      resolve(j);
    };
    const l: Listener = (e) => {
      if (e.job.id === job.id && TERMINAL.has(e.job.status)) finish(e.job);
    };
    listeners.add(l);
    const poll = setInterval(() => {
      void api<RenderJobDto>(`/render-jobs/${job.id}`)
        .then((j) => TERMINAL.has(j.status) && finish(j))
        .catch(() => undefined);
    }, 1500);
    signal?.addEventListener('abort', () => {
      done = true;
      listeners.delete(l);
      clearInterval(poll);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}
