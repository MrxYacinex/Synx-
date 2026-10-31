import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewMessageEvent, WebViewNavigation } from 'react-native-webview/lib/WebViewTypes';
import type { WebViewHandle } from '../../lib/webview';
import { WatchOverlay } from '../../components/WatchOverlay';
import { useProfile } from '../../lib/profile';
import { useRoom, type JoinTarget } from '../../lib/useRoom';
import { colors } from '../../lib/theme';
import { AGENT_SOURCE } from '../../agent/agentSource.generated';
import { PLATFORMS, isAllowedNavigation } from '../../shared/reel';
import type { AgentConfig } from '../../shared/bridge';
import { normalizeRoomCode, type PlatformId } from '../../shared/protocol';

/**
 * Present as the platform's normal mobile website. Some sites hide content or
 * push "open the app" walls for user agents that look like an embedded WebView.
 */
const USER_AGENT =
  Platform.OS === 'ios'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

export default function RoomScreen() {
  useKeepAwake();
  const params = useLocalSearchParams<{ code: string; platform?: PlatformId }>();
  const [profile] = useProfile();
  const webRef = useRef<WebViewHandle>(null);
  const canGoBack = useRef(false);
  const [webKey, setWebKey] = useState(0);
  const [soundOn, setSoundOn] = useState(true);

  // Decide once what we are joining; later param changes must not reconnect.
  const target = useMemo<JoinTarget>(() => {
    if (params.code === 'new') return { create: params.platform ?? 'instagram' };
    return { room: normalizeRoomCode(String(params.code ?? '')) };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const room = useRoom(profile, target, webRef);

  useEffect(() => {
    if (profile) setSoundOn(profile.sound);
  }, [profile?.sound]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (room.agent) setSoundOn(room.agent.soundOn);
  }, [room.agent?.soundOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Errors before we ever got in (bad code, full room, old app) send you back home.
  useEffect(() => {
    if (room.error && !room.room) {
      router.replace({ pathname: '/', params: { error: room.error.message, code: 'room' in target ? target.room : '' } });
    }
  }, [room.error, room.room, target]);

  const leave = useCallback(() => {
    Alert.alert('Leave the party?', undefined, [
      { text: 'Stay', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => (router.canGoBack() ? router.back() : router.replace('/')) },
    ]);
  }, []);

  // Android back button: go back inside the site first, then offer to leave.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        webRef.current?.goBack();
        return true;
      }
      leave();
      return true;
    });
    return () => sub.remove();
  }, [leave]);

  const platform = room.platform;
  const injected = useMemo(() => {
    if (!profile || !platform) return '';
    const config: AgentConfig = { platform, clientId: profile.clientId, sound: profile.sound, debug: __DEV__ };
    return `window.__SYNX_CONFIG__=${JSON.stringify(config)};\n${AGENT_SOURCE}\ntrue;`;
  }, [profile, platform]);

  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest) => {
      if (!platform) return false;
      if (req.isTopFrame === false) return true; // iframes (players, login widgets) are fine
      if (isAllowedNavigation(req.url, platform)) return true;
      // Links leaving the platform open in the system browser; app deep links
      // (instagram://, intent://, snssdk://…) are ignored so you stay in the party.
      if (/^https?:/i.test(req.url)) void Linking.openURL(req.url).catch(() => {});
      return false;
    },
    [platform],
  );

  if (!profile || !platform || room.initialUrl === null || !room.room) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.pink} size="large" />
        <Text style={styles.loadingText}>
          {room.status === 'reconnecting' ? `Can't reach the sync server yet…\n${profile?.serverUrl ?? ''}` : 'Connecting…'}
        </Text>
        <Pressable onPress={() => router.back()} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const startUrl = room.initialUrl || PLATFORMS[platform].homeUrl;

  return (
    <View style={styles.screen}>
      <WebView
        key={webKey}
        ref={webRef as never}
        source={{ uri: startUrl }}
        style={styles.web}
        userAgent={USER_AGENT}
        injectedJavaScriptBeforeContentLoaded={injected}
        injectedJavaScript={injected /* fallback for platforms where the early hook is unavailable; the agent ignores double init */}
        injectedJavaScriptForMainFrameOnly
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={(e: WebViewMessageEvent) => room.onWebMessage(e.nativeEvent.data)}
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={(n: WebViewNavigation) => (canGoBack.current = n.canGoBack)}
        onContentProcessDidTerminate={() => setWebKey((k) => k + 1)}
        onRenderProcessGone={() => setWebKey((k) => k + 1)}
        originWhitelist={['https://*', 'http://*', 'about:*', 'blob:*', 'data:*']}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo={false}
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        pullToRefreshEnabled={false}
        bounces={false}
        overScrollMode="never"
        decelerationRate="normal"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        webviewDebuggingEnabled={__DEV__}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.webLoading}>
            <ActivityIndicator color={colors.pink} />
          </View>
        )}
      />
      <WatchOverlay
        room={room.room}
        platform={platform}
        serverUrl={profile.serverUrl}
        clientId={profile.clientId}
        status={room.status}
        members={room.members}
        state={room.state}
        agent={room.agent}
        toasts={room.toasts}
        chats={room.chats}
        reactions={room.reactions}
        soundOn={soundOn}
        onLeave={leave}
        onTogglePlay={room.togglePlay}
        onRate={room.setRate}
        onSound={(on) => (setSoundOn(on), room.setSound(on))}
        onReact={room.react}
        onChat={room.chat}
        onRejoin={room.rejoin}
        onLogin={() => webRef.current?.injectJavaScript(`location.href=${JSON.stringify(PLATFORMS[platform].loginUrl)};true;`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  webLoading: { ...StyleSheet.absoluteFill, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 18, padding: 30 },
  loadingText: { color: colors.muted, fontSize: 16, textAlign: 'center', lineHeight: 22 },
  cancel: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 22, backgroundColor: colors.card },
  cancelText: { color: colors.text, fontWeight: '700' },
});
