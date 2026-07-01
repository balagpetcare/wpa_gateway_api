export const adminPermissions = {
  SUPER_ADMIN: ['*'],
  ADMIN: [
    'dashboard.read',
    'admin_users.read',
    'admin_users.create',
    'admin_users.update',
    'admin_users.delete',
    'admin_users.invite',
    'roles.read',
    'roles.update',
    'payments.read',
    'payments.update',
    'merchants.read',
    'merchants.update',
    'transactions.read',
    'settings.read',
    'settings.update',
    'audit_logs.read'
  ],
  MANAGER: [
    'dashboard.read',
    'payments.read',
    'payments.update',
    'merchants.read',
    'merchants.update',
    'transactions.read',
    'settings.read',
    'settings.update',
    'audit_logs.read'
  ],
  SUPPORT: [
    'dashboard.read',
    'admin_users.read',
    'merchants.read',
    'payments.read',
    'transactions.read'
  ],
  AUDITOR: [
    'dashboard.read',
    'admin_users.read',
    'roles.read',
    'payments.read',
    'merchants.read',
    'transactions.read',
    'settings.read',
    'audit_logs.read'
  ],
  DEVELOPER: [
    'dashboard.read',
    'admin_users.read',
    'roles.read',
    'payments.read',
    'merchants.read',
    'transactions.read',
    'settings.read',
    'settings.update',
    'audit_logs.read'
  ]
} as const;

export type AdminRoleName = keyof typeof adminPermissions;

const oldToNewPermissionMap: Record<string, string> = {
  'audit:read': 'audit_logs.read',
  'callbacks:read': 'payments.read',
  'webhooks:read': 'payments.read',
  'sessions:read': 'payments.read',
  'transactions:read': 'transactions.read',
  'merchants:read': 'merchants.read',
  'merchants:write': 'merchants.update',
  'providers:read': 'settings.read',
  'providers:write': 'settings.update',
  'settlement-profiles:read': 'payments.read',
  'settlement-profiles:write': 'payments.update',
  'settlements:read': 'payments.read',
  'payouts:read': 'payments.read',
  'payouts:write': 'payments.update',
  'payouts:approve': 'payments.update',
  'payouts:mark-success': 'payments.update',
  'refunds:read': 'payments.read',
  'refunds:write': 'payments.update'
};

export const hasPermission = (role: string, permission: string) => {
  if (!(role in adminPermissions)) {
    return false;
  }

  const permissions = adminPermissions[role as AdminRoleName] as readonly string[];
  if (permissions.includes('*')) return true;

  if (permissions.includes(permission)) return true;

  const mapped = oldToNewPermissionMap[permission];
  if (mapped && permissions.includes(mapped)) return true;

  return false;
};
