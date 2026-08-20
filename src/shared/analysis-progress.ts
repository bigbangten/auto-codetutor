import type { BackgroundAnalysisStatus } from './contracts.js';

type ProgressStatus = Pick<BackgroundAnalysisStatus, 'total' | 'completed' | 'failed'>;

export function analysisProcessedCount(status: ProgressStatus): number {
  const total = Math.max(0, status.total);
  const processed = Math.max(0, status.completed) + Math.max(0, status.failed);
  return total ? Math.min(total, processed) : processed;
}

export function analysisProgressPercent(status: ProgressStatus): number {
  if (status.total <= 0) return 0;
  return Math.min(100, analysisProcessedCount(status) / status.total * 100);
}

export function analysisProgressLabel(status: ProgressStatus): string {
  const processed = analysisProcessedCount(status).toLocaleString('ko-KR');
  const total = Math.max(0, status.total).toLocaleString('ko-KR');
  if (status.failed <= 0) return `${processed}/${total} 처리`;
  return `${processed}/${total} 처리 · 완료 ${Math.max(0, status.completed).toLocaleString('ko-KR')} · 실패 ${Math.max(0, status.failed).toLocaleString('ko-KR')}`;
}
