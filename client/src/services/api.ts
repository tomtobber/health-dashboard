import {
  MetricDefinition,
  EnrichedMetricQueryResult,
  DashboardView,
  DashboardViewConfig,
  MetricValueType,
  BaselineResult,
  BaselineHistoryItem,
  BaselineHistoryRefreshSummary,
  TrendResult,
  BaselineConfigResult,
  CorrelationResult,
} from '../types';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 12000;

export function getToken(): string | null {
  return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
}

async function request<T>(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);

  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(endpoint, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
    });

    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new ApiError(
        response.status,
        data.code || 'UNKNOWN_ERROR',
        data.error || `HTTP error ${response.status}`,
        data.context
      );
    }

    return data as T;
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(408, 'TIMEOUT', 'Request timed out after 10 seconds');
    }
    throw new ApiError(
      500,
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Network request failed'
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export const api = {
  // Auth
  async login(email: string, password: string): Promise<{ token: string; user: { id: string; email: string } }> {
    const res = await request<{ token: string; user: { id: string; email: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    return res;
  },

  async register(email: string, password: string): Promise<{ token: string; user: { id: string; email: string } }> {
    const res = await request<{ token: string; user: { id: string; email: string } }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(res.token);
    return res;
  },

  async getCurrentUser(): Promise<{ user: { id: string; email: string } }> {
    return request<{ user: { id: string; email: string } }>('/api/auth/me');
  },

  // Metric Definitions
  async listMetricDefinitions(includeArchived = false): Promise<MetricDefinition[]> {
    const res = await request<{ metricDefinitions?: MetricDefinition[] }>(
      `/api/metric-definitions${includeArchived ? '?includeArchived=true' : ''}`
    );
    return res.metricDefinitions || [];
  },

  async createMetricDefinition(params: {
    metric_type: string;
    display_name: string;
    value_type: MetricValueType;
    unit?: string | null;
    category_values?: string[] | null;
  }): Promise<MetricDefinition> {
    const res = await request<{ metricDefinition: MetricDefinition }>('/api/metric-definitions', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return res.metricDefinition;
  },

  async archiveMetricDefinition(id: string): Promise<MetricDefinition> {
    const res = await request<{ metricDefinition: MetricDefinition }>(
      `/api/metric-definitions/${id}/archive`,
      { method: 'POST' }
    );
    return res.metricDefinition;
  },

  // Metric Entries
  async queryBatchEnrichedMetrics(params: {
    metric_types: string[];
    start_time: string;
    end_time: string;
    dimension?: string;
    aggregation?: string;
  }): Promise<EnrichedMetricQueryResult[]> {
    const query = new URLSearchParams({
      metric_types: params.metric_types.join(','),
      start_time: params.start_time,
      end_time: params.end_time,
    });
    if (params.dimension) query.append('dimension', params.dimension);
    if (params.aggregation) query.append('aggregation', params.aggregation);

    const res = await request<{ results?: EnrichedMetricQueryResult[]; metrics?: EnrichedMetricQueryResult[] }>(
      `/api/metric-entries?${query.toString()}`
    );
    return res.metrics || res.results || [];
  },

  async logManualEntry(params: {
    metric_type: string;
    start_time: string;
    end_time?: string;
    value_numeric?: number;
    value_text?: string;
    unit?: string | null;
  }): Promise<{ id: string; metricType: string }> {
    const res = await request<{ entry: { id: string; metricType: string } }>(
      '/api/metric-entries/manual',
      {
        method: 'POST',
        body: JSON.stringify(params),
      }
    );
    return res.entry;
  },

  async createDefinitionAndLogFirstEntry(params: {
    metric_type: string;
    display_name: string;
    value_type: MetricValueType;
    unit?: string | null;
    category_values?: string[] | null;
    entry: {
      start_time: string;
      end_time?: string;
      value_numeric?: number;
      value_text?: string;
      unit?: string | null;
    };
  }): Promise<{ definition: MetricDefinition; entry: { id: string; metricType: string } }> {
    return request('/api/metric-entries/manual/combined', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  // Dashboard Views
  async listDashboardViews(): Promise<DashboardView[]> {
    const res = await request<{ dashboardViews?: DashboardView[] }>('/api/dashboard-views');
    return res.dashboardViews || [];
  },

  async getDashboardView(id: string): Promise<DashboardView> {
    const res = await request<{ dashboardView: DashboardView }>(`/api/dashboard-views/${id}`);
    return res.dashboardView;
  },

  async createDashboardView(name: string, config: DashboardViewConfig): Promise<DashboardView> {
    const res = await request<{ dashboardView: DashboardView }>('/api/dashboard-views', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    });
    return res.dashboardView;
  },

  async updateDashboardView(id: string, params: { name?: string; config?: DashboardViewConfig }): Promise<DashboardView> {
    const res = await request<{ dashboardView: DashboardView }>(`/api/dashboard-views/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(params),
    });
    return res.dashboardView;
  },

  async deleteDashboardView(id: string): Promise<{ success: boolean; message: string }> {
    return request<{ success: boolean; message: string }>(`/api/dashboard-views/${id}`, {
      method: 'DELETE',
    });
  },

  // Connected Accounts / Sync
  async getConnectedAccounts(): Promise<Array<{ provider: string; status: string; healthUserId?: string }>> {
    const res = await request<{ connectedAccounts?: Array<{ provider: string; status: string; healthUserId?: string }> }>(
      '/api/connect/status'
    ).catch(() => ({ connectedAccounts: [] }));
    return res.connectedAccounts || [];
  },

  async getGoogleAuthUrl(): Promise<{ authUrl: string; url: string }> {
    return request<{ authUrl: string; url: string }>('/api/connect/google/authorize');
  },

  async seedDemoData(): Promise<{ success: boolean; count: number; message: string }> {
    return request<{ success: boolean; count: number; message: string }>('/api/sync/seed-demo', {
      method: 'POST',
    });
  },

  async triggerSync(trigger = 'manual'): Promise<{ status: string }> {
    return request<{ status: string }>('/api/sync/trigger', {
      method: 'POST',
      body: JSON.stringify({ trigger }),
    }).catch(() => ({ status: 'pending' }));
  },

  // Baselines & Trend Detection
  async getBaseline(metricType: string, windowDays?: number): Promise<BaselineResult> {
    const query = windowDays ? `?windowDays=${windowDays}` : '';
    return request<BaselineResult>(`/api/metrics/${encodeURIComponent(metricType)}/baseline${query}`);
  },


  async getCorrelation(metricTypeA: string, metricTypeB: string, windowDays?: number): Promise<CorrelationResult> {
    const params = new URLSearchParams({
      metricTypeA,
      metricTypeB,
    });
    if (windowDays !== undefined) {
      params.append('windowDays', windowDays.toString());
    }
    return request<CorrelationResult>(`/api/metrics/correlation?${params.toString()}`);
  },
  async getTrend(metricType: string, windowDays?: number): Promise<TrendResult> {
    const query = windowDays ? `?windowDays=${windowDays}` : '';
    return request<TrendResult>(`/api/metrics/${encodeURIComponent(metricType)}/trend${query}`);
  },

  async getBaselineConfig(metricType: string): Promise<BaselineConfigResult> {
    return request<BaselineConfigResult>(`/api/metrics/${encodeURIComponent(metricType)}/baseline-config`);
  },

  async setBaselineConfig(metricType: string, windowDays: number): Promise<BaselineConfigResult> {
    return request<BaselineConfigResult>(`/api/metrics/${encodeURIComponent(metricType)}/baseline-config`, {
      method: 'PUT',
      body: JSON.stringify({ windowDays }),
    });
  },

  async getBaselineHistory(
    metricType: string,
    startTime?: string,
    endTime?: string
  ): Promise<{ metricType: string; history: BaselineHistoryItem[] }> {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<{ metricType: string; history: BaselineHistoryItem[] }>(
      `/api/metrics/${encodeURIComponent(metricType)}/baseline-history${query}`
    );
  },

  async refreshBaselineHistory(metricType: string): Promise<BaselineHistoryRefreshSummary> {
    return request<BaselineHistoryRefreshSummary>(
      `/api/metrics/${encodeURIComponent(metricType)}/baseline-history/refresh`,
      {
        method: 'POST',
      }
    );
  },
};
