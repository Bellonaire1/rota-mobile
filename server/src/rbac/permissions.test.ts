import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPermission, Permission, TeamRole } from './permissions';

describe('hasPermission', () => {
  it('grants OWNER an owner-only permission', () => {
    assert.equal(hasPermission(TeamRole.OWNER, Permission.MANAGE_MANAGERS), true);
  });

  it('grants OWNER ordinary operational permission', () => {
    assert.equal(hasPermission(TeamRole.OWNER, Permission.VIEW_OPERATIONAL_WORK), true);
  });

  it('denies MANAGER an owner-only permission', () => {
    assert.equal(hasPermission(TeamRole.MANAGER, Permission.MANAGE_MANAGERS), false);
  });

  it('grants MANAGER a manager-level permission', () => {
    assert.equal(hasPermission(TeamRole.MANAGER, Permission.MANAGE_STAFF), true);
  });

  it('denies STAFF a manager-level permission', () => {
    assert.equal(hasPermission(TeamRole.STAFF, Permission.MANAGE_STAFF), false);
  });

  it('grants STAFF ordinary staff permission', () => {
    assert.equal(hasPermission(TeamRole.STAFF, Permission.VIEW_OPERATIONAL_WORK), true);
  });

  it('does not grant an unsupported permission', () => {
    const unsupportedPermission = 'manage:unsupported' as Permission;

    assert.equal(
      hasPermission(TeamRole.OWNER, unsupportedPermission),
      false
    );
  });
});
