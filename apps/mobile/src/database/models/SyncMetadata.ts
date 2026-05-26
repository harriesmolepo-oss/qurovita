import { Model } from '@nozbe/watermelondb';
import { field, readonly, date } from '@nozbe/watermelondb/decorators';

export default class SyncMetadata extends Model {
  static table = 'sync_metadata';

  @field('key') key!: string;
  @field('value') value!: string;

  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
