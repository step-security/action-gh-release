import { setFailed, setOutput, error, info } from '@actions/core';
import { getOctokit } from '@actions/github';
import { GitHubReleaser, release, finalizeRelease, upload, listReleaseAssets } from './github';
import { isTag, parseConfig, paths, unmatchedPatterns, uploadUrl } from './util';
import axios, { isAxiosError } from 'axios';
import * as fs from 'fs';

import { env } from 'process';

async function run() {
  try {
    await validateSubscription();
    const config = parseConfig(env);
    if (!config.input_tag_name && !isTag(config.github_ref) && !config.input_draft) {
      throw new Error(`⚠️ GitHub Releases requires a tag`);
    }
    if (config.input_files) {
      const patterns = unmatchedPatterns(config.input_files, config.input_working_directory);
      patterns.forEach((pattern) => {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(`⚠️  Pattern '${pattern}' does not match any files.`);
        } else {
          console.warn(`🤔 Pattern '${pattern}' does not match any files.`);
        }
      });
      if (patterns.length > 0 && config.input_fail_on_unmatched_files) {
        throw new Error(`⚠️ There were unmatched files`);
      }
    }

    // const oktokit = GitHub.plugin(
    //   require("@octokit/plugin-throttling"),
    //   require("@octokit/plugin-retry")
    // );

    const gh = getOctokit(config.github_token, {
      //new oktokit(
      throttle: {
        onRateLimit: (retryAfter, options) => {
          console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
          if (options.request.retryCount === 0) {
            // only retries once
            console.log(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter, options) => {
          // does not retry, only logs a warning
          console.warn(`Abuse detected for request ${options.method} ${options.url}`);
        },
      },
    });
    //);
    const releaser = new GitHubReleaser(gh);
    const releaseResult = await release(config, releaser);
    let rel = releaseResult.release;
    const releaseWasCreated = releaseResult.created;
    let uploadedAssetIds: Set<number> = new Set();
    if (config.input_files && config.input_files.length > 0) {
      const files = paths(config.input_files, config.input_working_directory);
      if (files.length == 0) {
        if (config.input_fail_on_unmatched_files) {
          throw new Error(`⚠️ ${config.input_files} does not include a valid file.`);
        } else {
          console.warn(`🤔 ${config.input_files} does not include a valid file.`);
        }
      }
      const currentAssets = rel.assets;

      const uploadFile = async (path: string) => {
        const json = await upload(config, releaser, uploadUrl(rel.upload_url), path, currentAssets);
        return json ? (json.id as number) : undefined;
      };

      let results: (number | undefined)[];
      if (!config.input_preserve_order) {
        results = await Promise.all(files.map(uploadFile));
      } else {
        results = [];
        for (const path of files) {
          results.push(await uploadFile(path));
        }
      }

      uploadedAssetIds = new Set(results.filter((id): id is number => id !== undefined));
    }

    console.log('Finalizing release...');
    rel = await finalizeRelease(config, releaser, rel, releaseWasCreated);

    // Draft releases use temporary "untagged-..." URLs for assets.
    // URLs will be changed to correct ones once the release is published.
    console.log('Getting assets list...');
    {
      let assets: any[] = [];
      if (uploadedAssetIds.size > 0) {
        const updatedAssets = await listReleaseAssets(config, releaser, rel);
        assets = updatedAssets
          .filter((a) => uploadedAssetIds.has(a.id))
          .map((a) => {
            const { uploader, ...rest } = a;
            return rest;
          });
      }
      setOutput('assets', assets);
    }

    console.log(`🎉 Release ready at ${rel.html_url}`);
    setOutput('url', rel.html_url);
    setOutput('id', rel.id.toString());
    setOutput('upload_url', rel.upload_url);
  } catch (error) {
    setFailed(error.message);
  }
}

run();

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'softprops/action-gh-release';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  info('');
  info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 403) {
      error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`,
      );
      error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    info('Timeout or API not reachable. Continuing to next step.');
  }
}
