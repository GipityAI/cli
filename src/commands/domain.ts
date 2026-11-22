import { Command } from 'commander';
import { get, post, del } from '../api.js';
import { getConfig, requireConfig } from '../config.js';
import { error as clrError, success, muted, brand } from '../colors.js';
import { run, printList } from '../helpers/index.js';

interface DomainData {
  short_guid: string;
  domain: string;
  status: string;
  /** 'site' serves the environment's pages; 'mcp' its MCP server. */
  kind: 'site' | 'mcp';
  /** The environment the domain targets (list only): prod or the env's name. */
  env?: string;
  verified_at: string | null;
  created_at: string;
}

interface AccountDomainEntry {
  shortGuid: string;
  domain: string;
  status: string;
  kind: 'site' | 'mcp';
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
    instructions: { type: string; name: string; target: string; note: string; connect?: string };
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
  .option('--mcp', "add: serve this environment's MCP server at the domain (people connect Claude or ChatGPT to https://<domain>) instead of its pages")
  .option('--json', 'Output as JSON')
  .action((action: string | undefined, value: string | undefined, opts) => run('Domain', async () => {
    const sub = (action || 'list').toLowerCase();

    switch (sub) {
      case 'list': {
        if (opts.all) {
          // Account-wide list - no project context needed
          const res = await get<{ data: AccountDomainsResponse }>('/users/me/domains');
          const { domains, count, limit } = res.data;

          if (opts.json) {
            console.log(JSON.stringify(res.data));
            return;
          }

          console.log(`${muted('Domains:')} ${brand(`${count}/${limit}`)}\n`);

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

          let first = true;
          for (const [label, doms] of grouped) {
            if (!first) console.log('');
            first = false;
            console.log(brand(label));
            for (const d of doms) {
              console.log(`${d.domain}  ${d.kind}  ${muted(d.status)}  ${muted(`[${d.shortGuid}]`)}`);
            }
          }
        } else {
          const config = requireConfig();
          const res = await get<{ data: DomainData[] }>(`/projects/${config.projectGuid}/domains`);
          // Every domain of the app, each with what it serves and the environment it targets.
          printList(res.data, opts, 'No custom domains configured.', d =>
            `${d.domain}  ${d.kind}  ${muted(`env ${d.env ?? 'prod'}`)}  ${muted(d.status)}  ${muted(`[${d.short_guid}]`)}`
          );
        }
        break;
      }

      case 'add': {
        const config = requireConfig();
        if (!value) {
          console.error(clrError('Usage: gipity domain add <domain.com> [--mcp] [--env <name>]'));
          process.exit(1);
        }
        const res = await post<AddDomainResponse>(`/projects/${config.projectGuid}/domains`, { domain: value, kind: opts.mcp ? 'mcp' : 'site' });
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data));
        } else {
          console.log(success(`Domain "${data.domain.domain}" added.`));
          console.log('');
          console.log('Add this DNS record:');
          console.log(`${muted('Type:'.padEnd(8))}${data.instructions.type}`);
          console.log(`${muted('Name:'.padEnd(8))}${data.instructions.name}`);
          console.log(`${muted('Target:'.padEnd(8))}${data.instructions.target}`);
          if (data.instructions.note) {
            console.log('');
            console.log(data.instructions.note);
          }
          if (data.instructions.connect) console.log(data.instructions.connect);
          console.log('');
          console.log(muted(`Then run: gipity domain verify ${data.domain.short_guid}`));
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
          if (data.domain.kind === 'mcp') {
            console.log(`MCP server: ${success(`https://${data.domain.domain}`)}`);
            console.log(muted('Redeploy this environment so Gipity.app.mcpUrl, {{APP_MCP_URL}} and llms.txt show the new address.'));
          } else {
            console.log(`Live at: ${success(`https://${data.domain.domain}`)}`);
            console.log(muted('Redeploy this environment once so sign-in on this domain is first-party (works in every browser).'));
          }
        }
        break;
      }

      case 'remove':
      case 'delete': {
        if (!value) {
          console.error(clrError('Usage: gipity domain remove <guid>'));
          process.exit(1);
        }
        // Remove works with just the guid - try account-level first, fall back to project-level
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
        console.log(`${brand('gipity domain list')}              ${muted('List project domains')}`);
        console.log(`${brand('gipity domain list --all')}        ${muted('List all domains across projects')}`);
        console.log(`${brand('gipity domain add <domain.com>')}  ${muted('Add a custom domain (requires project)')}`);
        console.log(`${brand('gipity domain add <host> --mcp')}  ${muted("Serve this environment's MCP server at the domain (with --env <name> for another env)")}`);
        console.log(`${brand('gipity domain verify <guid>')}     ${muted('Verify DNS and activate (requires project)')}`);
        console.log(`${brand('gipity domain remove <guid>')}     ${muted('Remove a custom domain')}`);
    }
  }));
