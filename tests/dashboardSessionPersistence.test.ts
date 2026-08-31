/**
 * Client Dashboard Session & Draft Persistence Tests
 * Simulates the debounced localStorage persistence and clearTimeout on save
 */

interface LocalStorageInterface {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

describe('Client Dashboard Session Persistence & Debounce Cleanup', () => {
  let localStorageMock: Record<string, string>;
  let storage: LocalStorageInterface;

  beforeEach(() => {
    jest.useFakeTimers();
    localStorageMock = {};
    storage = {
      getItem: (key: string) => localStorageMock[key] ?? null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value;
      },
      removeItem: (key: string) => {
        delete localStorageMock[key];
      },
      clear: () => {
        localStorageMock = {};
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const getLastViewIdKey = (userId: string) => `dashboard:lastViewId:${userId}`;
  const getDraftKey = (viewId: string) => `dashboard:draft:${viewId}`;
  const getScratchDraftKey = (userId: string) => `dashboard:draft:scratch:${userId}`;

  test('edits persist to storage after debounce timer fires', () => {
    const viewId = 'view-123';
    let debounceTimer: NodeJS.Timeout | null = null;
    const panels = [{ id: 'p1', metricTypes: ['heart-rate'] }];

    // Trigger edit
    debounceTimer = setTimeout(() => {
      storage.setItem(getDraftKey(viewId), JSON.stringify(panels));
      debounceTimer = null;
    }, 500);

    // Immediately before 500ms, draft not yet saved
    expect(storage.getItem(getDraftKey(viewId))).toBeNull();

    // Fast-forward timer by 500ms
    jest.advanceTimersByTime(500);

    expect(storage.getItem(getDraftKey(viewId))).toBe(JSON.stringify(panels));
  });

  test('save within debounce window cancels pending timer and permanently clears draft', () => {
    const viewId = 'view-123';
    let debounceTimer: NodeJS.Timeout | null = null;
    const editedPanels = [{ id: 'p1', metricTypes: ['heart-rate', 'steps'] }];

    // 1. User performs an edit at t=0ms (starts 500ms debounce timer)
    debounceTimer = setTimeout(() => {
      storage.setItem(getDraftKey(viewId), JSON.stringify(editedPanels));
      debounceTimer = null;
    }, 500);

    // 2. User clicks "Update View" at t=200ms
    jest.advanceTimersByTime(200);

    // handleUpdateView logic: clear timer and remove draft key immediately
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    storage.removeItem(getDraftKey(viewId));

    // Confirm draft is cleared at t=200ms
    expect(storage.getItem(getDraftKey(viewId))).toBeNull();

    // 3. Fast-forward past the original 500ms debounce window (e.g. advance another 1000ms)
    jest.advanceTimersByTime(1000);

    // Assert that the draft key did NOT get recreated by a lingering timer
    expect(storage.getItem(getDraftKey(viewId))).toBeNull();
  });

  test('save current scratch view within debounce window cancels timer and clears scratch draft', () => {
    const userId = 'user-abc';
    const newViewId = 'view-saved-456';
    let debounceTimer: NodeJS.Timeout | null = null;
    const scratchPanels = [{ id: 'p-custom', metricTypes: ['sleep'] }];

    // User edits scratch layout at t=0ms
    debounceTimer = setTimeout(() => {
      storage.setItem(getScratchDraftKey(userId), JSON.stringify(scratchPanels));
      debounceTimer = null;
    }, 500);

    // User clicks "Save View" at t=150ms
    jest.advanceTimersByTime(150);

    // handleSaveCurrentView logic:
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    storage.setItem(getLastViewIdKey(userId), newViewId);
    storage.removeItem(getScratchDraftKey(userId));
    storage.removeItem(getDraftKey(newViewId));

    // Advance 1000ms
    jest.advanceTimersByTime(1000);

    // Drafts must remain completely clean
    expect(storage.getItem(getScratchDraftKey(userId))).toBeNull();
    expect(storage.getItem(getDraftKey(newViewId))).toBeNull();
    expect(storage.getItem(getLastViewIdKey(userId))).toBe(newViewId);
  });
});
