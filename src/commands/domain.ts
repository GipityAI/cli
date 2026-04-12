import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { getConfig, requireConfig } from '../config.js';
import { error as clrError, success, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

interface DomainData {
  short_guid: string;
  domain: string;
  status: string;
  verified_at: string | null;
  created_at: string;
}

interface AccountDomainEntry {
  shortGuid: string;
  domain: string;
  status: string;
  projectName: string | null;
  projectSlug: string | null;
  createdAt: string;
}

interface AccountDomainsResponse {
  domains: AccountDomainEntry[];
  count: number;
  limit: number;
}

interface AddDomainResponse {
  data: {
    domain: DomainData;
    instructions: { type: string; name: string; target: string; note: string };
  };
}

interface VerifyDomainResponse {
  data: {
    domain: DomainData;
    alreadyActive: boolean;
  };
}

export const domainCommand = new Command('domain')
  .description('Manage custom domains')
  .argument('[action]', 'list | add | verify | remove')
  .argument('[value]', 'domain name (for add) or domain ID (for verify/remove)')
  .option('--all', 'List domains across all projects')
  .option('--json', 'Output as JSON')
  .action((action: string | undefined, value: string | undefined, opts) => run('Domain', async () => {
    const sub = (action || 'list').toLowerCase();

    switch (sub) {
      case 'list': {
        if (opts.all) {
          // Account-wide list — no project context needed
          const res = await get<{ data: AccountDomainsResponse }>('/users/me/domains');
          const { domains, count, limit } = res.data;

          if (opts.json) {
            console.log(JSON.stringify(res.data));
            return;
          }

          console.log(`Domains: ${count}/${limit}\n`);

          if (domains.length === 0) {
            console.log('No custom domains.');
            return;
          }

          // Group by project
          const grouped = new Map<string, AccountDomainEntry[]>();
          for (const d of domains) {
            const key = d.projectSlug || d.projectName || 'unknown';
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(d);
          }

          for (const [label, doms] of grouped) {
            console.log(label);
            for (const d of doms) {
              console.log(`  ${d.domain}  ${muted(d.status)}  ${muted(`[${d.shortGuid}]`)}`);
            }
            console.log();
          }
        } else {
          const config = requireConfig();
          const res = await get<{ data: DomainData[] }>(`/projects/${config.projectGuid}/domains`);
          printList(res.data, opts, 'No custom domains configured.', d =>
            `  ${d.domain}  ${muted(d.status)}  ${muted(`[${d.short_guid}]`)}`
          );
        }
        break;
      }

      case 'add': {
        const config = requireConfig();
        if (!value) {
          console.error(clrError('Usage: gipity domain add <domain.com>'));
          process.exit(1);
        }
        const res = await post<AddDomainResponse>(`/projects/${config.projectGuid}/domains`, { domain: value });
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data));
        } else {
          console.log(success(`Domain "${data.domain.domain}" added.`));
          console.log('');
          console.log('Add this DNS record:');
          console.log(`  Type:   ${data.instructions.type}`);
          console.log(`  Name:   ${data.instructions.name}`);
          console.log(`  Target: ${data.instructions.target}`);
          if (data.instructions.note) {
            console.log('');
            console.log(data.instructions.note);
          }
          console.log('');
          console.log(`Then run: gipity domain verify ${data.domain.short_guid}`);
        }
        break;
      }

      case 'verify': {
        const config = requireConfig();
        if (!value) {
          console.error(clrError('Usage: gipity domain verify <guid>'));
          process.exit(1);
        }
        const res = await post<VerifyDomainResponse>(`/projects/${config.projectGuid}/domains/${value}/verify`);
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data));
        } else if (data.alreadyActive) {
          console.log(`Domain "${data.domain.domain}" is already active.`);
        } else {
          console.log(success(`Domain "${data.domain.domain}" verified and active!`));
          console.log(`Live at: ${success(`https://${data.domain.domain}`)}`);
        }
        break;
      }

      case 'remove':
      case 'delete': {
        if (!value) {
          console.error(clrError('Usage: gipity domain remove <guid>'));
          process.exit(1);
        }
        // Remove works with just the guid — try account-level first, fall back to project-level
        const config = getConfig();
        if (config) {
          await del(`/projects/${config.projectGuid}/domains/${value}`);
        } else {
          await del(`/users/me/domains/${value}`);
        }
        if (opts.json) {
          console.log(JSON.stringify({ success: true }));
        } else {
          console.log('Domain removed.');
        }
        break;
      }

      default:
        console.log('Usage: gipity domain [list|add|verify|remove]');
        console.log('');
        console.log('  gipity domain list              List project domains');
        console.log('  gipity domain list --all        List all domains across projects');
        console.log('  gipity domain add <domain.com>  Add a custom domain (requires project)');
        console.log('  gipity domain verify <guid>     Verify DNS and activate (requires project)');
        console.log('  gipity domain remove <guid>     Remove a custom domain');
    }
  }));
