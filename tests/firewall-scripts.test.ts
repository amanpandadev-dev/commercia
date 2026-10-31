import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// These scripts run on Windows, which the tests do not. This only guards what they must never come to say.
describe('the Windows firewall script', () => {
  const ps = fs.readFileSync('scripts/windows/firewall.ps1', 'utf8');
  const bat = fs.readFileSync('scripts/windows/firewall.bat', 'utf8');
  const code = ps.replace(/^\s*#.*$/gm, '');

  it('makes exactly one inbound rule, for the Private profile, from the local subnet (and Tailscale only on request)', () => {
    expect(code.match(/New-NetFirewallRule/g)).toHaveLength(1);
    expect(code).toMatch(/-Direction Inbound/);
    expect(code).toMatch(/-Action Allow/);
    expect(code).toMatch(/-Profile Private\b/);
    expect(code).not.toMatch(/-Profile[^\n]*(Public|Domain|Any)/i);
    expect(code).toMatch(/\$remote = @\('LocalSubnet'\)/);
    expect(code).toMatch(/if \(\$Tailscale\) \{ \$remote \+= '100\.64\.0\.0\/10' \}/);
    expect(code).not.toMatch(/-RemoteAddress\s+(Any|\*|0\.0\.0\.0)/i);
    expect(code).toMatch(/-EdgeTraversalPolicy Block/);
  });

  it('removes any earlier rule of its name first, so running it again never leaves two, and can remove it', () => {
    expect(code).toMatch(/Get-NetFirewallRule -DisplayName \$RuleName/);
    expect(code).toMatch(/Remove-NetFirewallRule/);
    expect(code.indexOf('Remove-OurRule # exactly one rule')).toBeLessThan(code.indexOf('New-NetFirewallRule'));
    expect(code).toMatch(/'remove' \{\s*Remove-OurRule/);
  });

  it('does not change anything without Administrator rights, and shows the rule and any broad Node.js rule', () => {
    expect(code).toMatch(/-not \$isAdmin -and \$Action -ne 'status'/);
    expect(code).toMatch(/node\.exe/);
  });

  it('never advises opening a router port', () => {
    expect(ps.toLowerCase()).not.toMatch(/port.?forward|open (a |the )?router port/);
    expect(ps).toMatch(/Nothing here opens a router port/);
  });

  it('has a wrapper that asks Windows for permission, with Windows line endings', () => {
    expect(bat).toContain('-Verb RunAs');
    expect(bat).toMatch(/\r\n/);
    expect(bat).toContain('firewall.ps1');
  });
});
