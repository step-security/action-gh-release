import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  info: mocks.info,
  error: mocks.error,
}));

vi.mock('axios', () => {
  const mockPost = vi.fn();
  return {
    default: { post: mockPost },
    isAxiosError: (err: unknown) =>
      typeof err === 'object' &&
      err !== null &&
      (err as { isAxiosError?: boolean }).isAxiosError === true,
  };
});

const mockAxiosPost = axios.post as ReturnType<typeof vi.fn>;

describe('validateSubscription', () => {
  const originalEnv = process.env;
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      GITHUB_EVENT_PATH: undefined,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_ACTION_REPOSITORY: 'step-security/action-gh-release',
      GITHUB_SERVER_URL: 'https://github.com',
    };
    process.exit = vi.fn() as never;
    mockAxiosPost.mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exit = originalExit;
  });

  it('prints the StepSecurity banner', async () => {
    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining('StepSecurity Maintained Action'),
    );
  });

  it('prints the upstream action name', async () => {
    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();
    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('softprops/action-gh-release'));
  });

  it('skips the subscription API call for a public repo', async () => {
    const eventPath = '/tmp/test-event-public.json';
    fs.writeFileSync(eventPath, JSON.stringify({ repository: { private: false } }));
    process.env.GITHUB_EVENT_PATH = eventPath;

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining('Free for public repositories'),
    );
    expect(mockAxiosPost).not.toHaveBeenCalled();

    fs.unlinkSync(eventPath);
  });

  it('calls the subscription API when repo privacy is unknown', async () => {
    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();
    expect(mockAxiosPost).toHaveBeenCalledOnce();
  });

  it('calls the subscription API when repo is private', async () => {
    const eventPath = '/tmp/test-event-private.json';
    fs.writeFileSync(eventPath, JSON.stringify({ repository: { private: true } }));
    process.env.GITHUB_EVENT_PATH = eventPath;

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Free for public repositories'),
    );
    expect(mockAxiosPost).toHaveBeenCalledOnce();

    fs.unlinkSync(eventPath);
  });

  it('posts to the correct endpoint with the action repository', async () => {
    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://agent.api.stepsecurity.io/v1/github/owner/repo/actions/maintained-actions-subscription',
      { action: 'step-security/action-gh-release' },
      { timeout: 3000 },
    );
  });

  it('includes ghes_server in the body when using a GHES instance', async () => {
    process.env.GITHUB_SERVER_URL = 'https://github.example.com';

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.any(String),
      { action: 'step-security/action-gh-release', ghes_server: 'https://github.example.com' },
      expect.any(Object),
    );
  });

  it('exits with an error when the API returns 403', async () => {
    const axiosError = Object.assign(new Error('Forbidden'), {
      isAxiosError: true,
      response: { status: 403 },
    });
    mockAxiosPost.mockRejectedValue(axiosError);

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('StepSecurity subscription'));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('continues when the API times out or is unreachable', async () => {
    mockAxiosPost.mockRejectedValue(new Error('Network Error'));

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mocks.info).toHaveBeenCalledWith(
      'Timeout or API not reachable. Continuing to next step.',
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('continues when GITHUB_EVENT_PATH points to a missing file', async () => {
    process.env.GITHUB_EVENT_PATH = '/tmp/does-not-exist.json';

    const { validateSubscription } = await import('../src/subscription');
    await validateSubscription();

    expect(mockAxiosPost).toHaveBeenCalledOnce();
  });
});
