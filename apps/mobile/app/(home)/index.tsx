import { View, Text, FlatList, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

// Placeholder rows — replaced by WatermelonDB-backed data in T4.5
const PLACEHOLDER_RECORDS = [
  { id: '1', type: 'Lab Result', date: '2025-03-12', facility: 'Groote Schuur Hospital' },
  { id: '2', type: 'Prescription', date: '2025-02-28', facility: 'TC Newman CHC' },
  { id: '3', type: 'Discharge Summary', date: '2024-11-05', facility: 'Karl Bremer Hospital' },
];

export default function RecordsScreen() {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      {PLACEHOLDER_RECORDS.length === 0 ? (
        <Text style={styles.empty}>{t('home.noRecords')}</Text>
      ) : (
        <FlatList
          data={PLACEHOLDER_RECORDS}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardType}>{item.type}</Text>
              <Text style={styles.cardMeta}>{item.facility}</Text>
              <Text style={styles.cardDate}>{item.date}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  list: {
    padding: 16,
    gap: 12,
  },
  empty: {
    flex: 1,
    textAlign: 'center',
    color: '#888',
    fontSize: 14,
    padding: 40,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardType: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a2e',
    marginBottom: 4,
  },
  cardMeta: {
    fontSize: 13,
    color: '#555',
    marginBottom: 2,
  },
  cardDate: {
    fontSize: 12,
    color: '#888',
  },
});
