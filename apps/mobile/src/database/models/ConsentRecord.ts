import { Model } from '@nozbe/watermelondb';
import { field, readonly, date } from '@nozbe/watermelondb/decorators';

export default class ConsentRecord extends Model {
  static table = 'consent_records';

  @field('server_id') serverId!: string | null;
  @field('consent_type') consentType!: string;
  @field('version') version!: string;
  @field('text_sha256') textSha256!: string;
  @field('granted') granted!: boolean;
  @field('granted_at') grantedAt!: number;
  @field('language') language!: string | null;
  @field('synced_at') syncedAt!: number | null;
  @field('needs_push') needsPush!: boolean;

  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
