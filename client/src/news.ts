// お知らせ（ホーム画面のニュース掲示板）。新しいものを先頭に足す。
// id は一度決めたら変えない（「NEW」の既読判定に使う）。

export interface NewsItem {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  body: string;
  tag?: '新機能' | '改善' | 'お知らせ';
}

export const NEWS: NewsItem[] = [
  {
    id: '2026-11-19-howto',
    date: '2026-11-19',
    tag: '改善',
    title: 'ロビーに「遊び方」を追加',
    body: 'ロビーの「遊び方」ボタンから、ノーマルとねらい撃ちのルールを図つきで見られます。ねらい撃ちでは、対戦前のカウントダウン中にも操作方法が出ます。',
  },
  {
    id: '2026-11-19-aim',
    date: '2026-11-19',
    tag: '新機能',
    title: '新モード「ねらい撃ち」',
    body: 'おじゃまを送る相手を自分で選べるモードです。相手の盤面をクリックするか 1〜9 キーで選び、0 でおまかせ（反撃）。ロビーの「モード」で切り替えられます。',
  },
  {
    id: '2026-11-19-online',
    date: '2026-11-19',
    tag: '新機能',
    title: 'オンライン人数を表示',
    body: '画面の上に、いまサイトを開いている人数と、対戦中の人数が出るようになりました。',
  },
  {
    id: '2026-11-17-chat',
    date: '2026-11-17',
    tag: '新機能',
    title: 'ロビーにチャットとスタンプ',
    body: '対戦の合間に、ロビーでチャットやスタンプを送れるようになりました。',
  },
  {
    id: '2026-11-14-neon',
    date: '2026-11-14',
    tag: '新機能',
    title: '新デザイン「NEON CYBER ARENA」',
    body: 'ネオンの見た目と、ライン消去や攻撃の演出を追加しました。画面上の切り替えで、いつでも CLASSIC に戻せます。',
  },
  {
    id: '2026-10-29-pause',
    date: '2026-10-29',
    tag: '新機能',
    title: '対戦中にみんなで一時停止',
    body: 'Esc のメニューから、対戦中の全員を止められます。止めた人が再開すると、3秒後に再スタートします。',
  },
];

const SEEN_KEY = 'linebreak.newsSeen';

/** Ids the visitor has already seen; empty on the very first visit. */
export function seenNews(): Set<string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

export function markNewsSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(NEWS.map((n) => n.id)));
  } catch {
    /* ignore */
  }
}
