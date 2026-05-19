import { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../../src/auth/AuthContext';
import { API_BASE_URL } from '../../src/config/api';
import i18n from '../../src/i18n';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocked?: boolean;
}

let msgCounter = 0;
function nextId() {
  return String(++msgCounter);
}

export default function AssistantScreen() {
  const { t } = useTranslation();
  const { jwt } = useAuthContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: nextId(), role: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/assistant/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt ?? ''}`,
        },
        body: JSON.stringify({ language: i18n.language, message: text }),
      });

      if (!res.ok) {
        throw new Error(t('assistant.errorUnknown'));
      }

      const data = await res.json() as { text: string; verdict: string };
      const assistantMsg: Message = {
        id: nextId(),
        role: 'assistant',
        text: data.text,
        blocked: data.verdict === 'blocked',
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      const errText = e instanceof Error ? e.message : t('assistant.errorUnknown');
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text: errText, blocked: false },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        {item.blocked && (
          <Text style={styles.blockedLabel}>ⓘ {t('assistant.blockedMessage')}</Text>
        )}
        <Text style={isUser ? styles.textUser : styles.textAssistant}>{item.text}</Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.disclaimer}>
        <Text style={styles.disclaimerText}>{t('assistant.disclaimer')}</Text>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.messageList}
        renderItem={renderMessage}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={t('assistant.placeholder')}
          multiline
          maxLength={500}
          editable={!loading}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || loading) && styles.sendDisabled]}
          onPress={() => void send()}
          disabled={!input.trim() || loading}
          accessibilityRole="button"
          accessibilityLabel={t('assistant.send')}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.sendText}>{t('assistant.send')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  disclaimer: {
    backgroundColor: '#fff3cd',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ffc107',
  },
  disclaimerText: {
    fontSize: 11,
    color: '#664d03',
    lineHeight: 16,
  },
  messageList: {
    padding: 12,
    gap: 8,
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: 12,
    padding: 12,
    marginBottom: 4,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#0066cc',
  },
  bubbleAssistant: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  textUser: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
  },
  textAssistant: {
    color: '#1a1a2e',
    fontSize: 14,
    lineHeight: 20,
  },
  blockedLabel: {
    color: '#cc0000',
    fontSize: 11,
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    gap: 8,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 100,
    backgroundColor: '#fafafa',
  },
  sendButton: {
    backgroundColor: '#0066cc',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 60,
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
