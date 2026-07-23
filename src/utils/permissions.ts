import type { AdminRole } from '@prisma/client';

export const adminPermissions: Record<AdminRole, readonly string[]> = {
  SUPER_ADMIN: ['*'],
  ADMIN: [
    'dashboard.read',
    'transactions.read',
    'refunds.manage',
    'settlements.read',
    'settlements.manage',
    'providers.read',
    'providers.manage',
    'api_credentials.read',
    'api_credentials.manage',
    'admin_users.read',
    'audit_logs.read',
  ],
  FINANCE_ADMIN: [
    'dashboard.read',
    'transactions.read',
    'refunds.manage',
    'settlements.read',
    'settlements.manage',
    'audit_logs.read',
  ],
  OPERATIONS_ADMIN: [
    'dashboard.read',
    'transactions.read',
    'providers.read',
    'providers.manage',
    'api_credentials.read',
    'api_credentials.manage',
    'settlements.read',
  ],
  VIEWER: [
    'dashboard.read',
    'transactions.read',
    'settlements.read',
    'providers.read',
    'api_credentials.read',
    'audit_logs.read',
  ],
};

export type AdminRoleName = keyof typeof adminPermissions;

const legacyPermissionMap: Record<string, string> = {
  'audit:read': 'audit_logs.read',
  'callbacks:read': 'transactions.read',
  'webhooks:read': 'transactions.read',
  'sessions:read': 'transactions.read',
  'transactions:read': 'transactions.read',
  'merchants:read': 'transactions.read',
  'merchants:write': 'providers.manage',
  'providers:read': 'providers.read',
  'providers:write': 'providers.manage',
  'settlement-profiles:read': 'settlements.read',
  'settlement-profiles:write': 'settlements.manage',
  'settlements:read': 'settlements.read',
  'payouts:read': 'settlements.read',
  'payouts:write': 'settlements.manage',
  'payouts:approve': 'settlements.manage',
  'payouts:mark-success': 'settlements.manage',
  'refunds:read': 'transactions.read',
  'refunds:write': 'refunds.manage',
  'payments.read': 'transactions.read',
  'payments.update': 'refunds.manage',
  'settings.read': 'providers.read',
  'settings.update': 'providers.manage',
  'admin_users.create': 'admin_users.manage',
  'admin_users.update': 'admin_users.manage',
  'admin_users.delete': 'admin_users.manage',
  'admin_users.invite': 'admin_users.manage',
  'roles.read': 'admin_users.read',
  'roles.update': 'admin_users.manage',
};

export const hasPermission = (role: string, permission: string) => {
  if (!(role in adminPermissions)) {
    return false;
  }

  const permissions = adminPermissions[role as AdminRoleName];
  if (permissions.includes('*')) {
    return true;
  }

  if (permissions.includes(permission)) {
    return true;
  }

  if (permission === 'admin_users.manage') {
    return role === 'SUPER_ADMIN';
  }

  const mapped = legacyPermissionMap[permission];
  if (mapped) {
    return permissions.includes(mapped) || (mapped === 'admin_users.manage' && role === 'SUPER_ADMIN');
  }

  return false;
};
