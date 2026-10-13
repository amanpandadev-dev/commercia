export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public details?: unknown) {
    super(message);
  }
}

type Listener = (code: string) => void;
const authListeners = new Set<Listener>();
export const onAuthLost = (fn: Listener) => {
  authListeners.add(fn);
  return () => {
    authListeners.delete(fn);
  };
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach Commercia. Check the laptop is on and connected — nothing you typed is lost.", 'offline');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const code = data?.code ?? 'error';
    if (res.status === 401 && !url.startsWith('/api/auth/')) authListeners.forEach((fn) => fn(code));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, code, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

/** Download a file from a POST that returns a blob (Excel exports). */
export async function download(url: string, body?: unknown, fallbackName = 'export') {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? 'Download failed', data.code ?? 'error');
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = cd.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export interface ExportColumn {
  header: string;
  key: string;
  type?: 'text' | 'money' | 'number' | 'date';
}
export const exportExcel = (fileName: string, sheets: { name: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }[]) =>
  download('/api/export', { fileName, sheets }, `${fileName}.xlsx`);
