import { useEffect, useState } from 'react';
import { Q } from '@nozbe/watermelondb';

import { getDatabase } from './index';
import FhirResource from './models/FhirResource';

/** Observe non-deleted FHIR resources for list UIs. */
export function useFhirResources(): {
  records: FhirResource[];
  loading: boolean;
} {
  const [records, setRecords] = useState<FhirResource[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getDatabase();
    const sub = db
      .get<FhirResource>('fhir_resources')
      .query(Q.where('is_deleted', false), Q.sortBy('server_updated_at', Q.desc))
      .observe()
      .subscribe((rows) => {
        setRecords(rows);
        setLoading(false);
      });
    return () => sub.unsubscribe();
  }, []);

  return { records, loading };
}
