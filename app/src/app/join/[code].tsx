import { Redirect, useLocalSearchParams } from 'expo-router';
import { normalizeRoomCode } from '../../shared/protocol';

/** Deep link: synx://join/ABCDE (and https://<server>/join/ABCDE via the server page). */
export default function JoinLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const room = normalizeRoomCode(String(code ?? ''));
  return <Redirect href={{ pathname: '/room/[code]', params: { code: room } }} />;
}
