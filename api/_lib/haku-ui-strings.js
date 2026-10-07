/**
 * api/_lib/haku-ui-strings.js
 * HAKU Community 会員ホームの「画面に出す文言」の唯一の置き場。
 *
 * - HTML側は {{t.グループ.キー}}、JavaScript側は UI.グループ.キー で参照する（どちらもここから読む）。
 * - 文言を直すときは、このファイルだけを直せばよい。
 * - {n} {name} などは、画面側で値に置き換わる。
 * - 内部データ名・APIのaction名は変えない（表示名と内部実装は分けている）。
 * - 方針：英語の大文字見出しは使わない。HAKU MORNING / HAKU NOTE などの固有名は、短い日本語の補足と一緒にだけ出す。
 *   未決定のルール（換算率・有効期限・交換条件など）は、会員向けの文言に出さない。
 */
export const UI = {
  meta: {
    title: 'HAKU Community｜あんたがおらな',
  },

  a11y: {
    skip: '本文へ移動',
    loadingRegion: '読み込み中',
  },

  brand: {
    line1: '教育支援団体',
    line2: 'あんたがおらな',
    memberLabel: 'HAKU Community 会員',
    service: 'HAKU Community', // PCのサイドバー上部に出すサービス名（運営団体の表示より大きく出す）
  },

  // 下部メニュー（PCでは上部）。表示順はこの並びで固定。
  nav: {
    aria: 'メインメニュー',
    home: 'ホーム',
    learn: '学ぶ',
    words: 'ことば',
    gather: '集う',
    point1: 'HAKU',
    point2: 'ポイント',
    pointFull: 'HAKUポイント',
    me: 'わたし',
    meAria: 'わたしの記録を開く',
  },

  greet: {
    morning: 'おはようございます、{name}さん。',
    day: 'こんにちは、{name}さん。',
    evening: 'こんばんは、{name}さん。',
    lead: '今日、HAKUとどう関わりますか。',
  },

  // ホーム最上部の「今日の一歩」（1つだけ出す）
  step: {
    kicker: '今日の一歩',
    loading: '今日の一歩を探しています…',
    joinedSoon: { lead: 'まもなく、参加予定の集まりです。', btn: '集まりの詳細を見る' },
    nextMorning: { lead: '次の朝の集まりの予約を受け付けています。', btn: '朝の集まりを見る' },
    joinedLater: { lead: '参加予定の集まりがあります。', btn: '予定を見る' },
    note: { lead: '今週の問いが届いています。', btn: '今週の問いを読む' },
    word: { lead: '今日のことばが届いています。', btn: 'ことばを読む' },
    write: { lead: '今日の気づきを、ひとこと残す。', btn: 'ことばを書く' },
  },

  home: {
    nextTitle: '直近の予定',
    nextMorning: '次回の朝の集まり',
    nextMeet: '次回の集まり',
    nextMorningEmpty: '現在、予定されている朝の集まりはありません。',
    nextMeetEmpty: '現在、予定されている集まりはありません。',
    nextEmptyNote: '開催が決まりましたら、ここにお知らせします。',
    seeGather: '集うで予約・確認する',
    noteTitle: '今週の問い',
    noteSupp: '学びのノート「HAKU NOTE」より',
    noteMore: '学ぶで読む',
    noteEmpty: '今週の問いは、まもなく届きます。',
    wordsTitle: 'ことば',
    wordLatest: 'HAKUからのことば',
    wordEmpty: 'HAKUからのことばは、まもなく届きます。',
    membersWords: '会員のことば',
    membersEmpty: 'まだ、ことばはありません。',
    wordsMore: 'ことばをもっと読む',
    challengeTitle: '毎朝の任意参加',
    challengeBody: '毎朝5時55分から、オンラインでつながる時間です。参加は自由です。無理のない範囲でどうぞ。',
    challengeLink: '555チャレンジに参加する（Google Meet）',
  },

  learn: {
    title: '学ぶ',
    lead: '毎週の問い「HAKU NOTE」と、これまでの学びを読めます。',
    current: '今週の問い',
    archive: 'これまでのHAKU NOTE',
    archiveSupp: '過去の問いを開いて、もう一度読めます。',
    emptyCurrent: '今週の問いは、まもなく届きます。',
    emptyArchive: 'これまでのHAKU NOTEは、まだありません。',
    more: 'もっと見る',
    supplement: '補足',
  },

  words: {
    title: 'ことば',
    lead: '運営のことばと、会員のことば。自分のことばも、ここに残せます。',
    official: 'HAKUからのことば',
    officialPast: 'これまでのことば',
    officialEmpty: 'これから、HAKUからのことばがここに届きます。',
    officialMore: 'これまでのことばをもっと見る',
    members: 'みんなのことば',
    membersEmpty: 'まだ、ことばはありません。',
    write: 'ことばを書く',
    edit: '編集',
    delete: '削除',
    hiddenBadge: '運営により非表示中',
    deleteConfirm: 'このことばを削除しますか？元に戻せません。',
    deleted: 'ことばを削除しました。',
    audioPlay: '再生',
    audioPause: '一時停止',
    audioSeek: '再生位置',
    audioFallback: '音声メッセージ',
  },

  composer: {
    headingNew: 'ことばを書く',
    headingEdit: 'ことばを編集する',
    category: 'カテゴリ',
    title: 'タイトル（任意・60文字まで）',
    titlePlaceholder: 'つけなくても大丈夫です',
    body: '本文（1000文字まで）',
    bodyPlaceholder: '今日できたこと、気づいたこと、考えていること。誰かと比べず、ただ自分の言葉で。',
    cancel: 'やめる',
    submitNew: '残す',
    submitEdit: '更新する',
    saving: '保存しています…',
    discardConfirm: '書きかけのことばを破棄しますか？',
    errBodyEmpty: '本文を入力してください。',
    errBodyLong: '本文は1000文字以内でご入力ください。',
    savedNew: 'ことばを残しました。',
    savedEdit: 'ことばを更新しました。',
    countAria: '入力した文字数',
  },

  gather: {
    title: '集う',
    lead: '朝の集まりやイベントの予約と、これまでの参加の記録です。',
    joined: '参加予定',
    open: '予約できる集まり',
    past: 'これまでの集まり',
    emptyJoined: '参加予定の集まりは、まだありません。',
    emptyOpen: '予約できる集まりは、いまありません。',
    emptyPast: '開催済みの集まりは、まだありません。',
    btnJoin: '参加する',
    btnJoining: '手続き中…',
    btnLeave: '参加を取り消す',
    btnLeaving: '取り消し中…',
    btnFull: '満席です',
    btnClosed: '受付を終了しました',
    chipJoined: '参加予定',
    chipCancelled: '中止',
    chipEnded: '開催済み',
    leaveConfirm: '参加を取り消しますか？',
    toastJoined: '参加予定に入れました。',
    toastLeft: '参加を取り消しました。',
    typeMorning: '朝の集まり（HAKU MORNING）',
    typeMeet: '集まり（HAKU MEET）',
    typeVolunteer: 'ボランティア',
    typeOther: '集まり',
    dateTbd: '日程調整中',
    capacity: '定員{cap}名・残り{rest}席',
    bring: '持ち物：{v}',
  },

  point: {
    title: 'HAKUポイント',
    philosophy1: '受け取ったものを、次の誰かへ。',
    philosophy2: 'HAKUポイントは、学びや行動を誰かへの価値に変えていく、その積み重ねです。',
    preparing: 'ただいま準備中です',
    now: '現在のポイント',
    unit: 'pt',
    history: 'これまでの記録',
    emptyHistory: 'まだ記録はありません。',
    more: '直近{n}件を表示しています。',
  },

  me: {
    title: 'わたしの記録',
    sinceNew: '会員になったばかりです。',
    since: '会員になって、{d}が経ちました。',
    goalsTitle: '今月の約束',
    goalsLead: '{month}に、自分と交わす小さな約束。3つまで決められます。',
    goalEmpty: '今月の約束は、まだありません。',
    goalLabel: '約束を加える',
    goalPlaceholder: '例：毎朝6時に起きる',
    goalAdd: '加える',
    goalAdding: '加えています…',
    goalDoneToday: '今日できた',
    goalMonth: '記録を見る・つける',
    goalCount: '今月 {n}日',
    goalDelete: 'この約束をやめる',
    goalDeleteConfirm: 'この約束をやめますか？記録も消えます。',
    goalSaved: '記録しました。',
    goalLimit: '今月の約束は3つまでです。',
    dayAria: '{m}月{d}日',
    dayDone: 'できた',
    dayNotYet: 'まだ',
    recentTitle: '最近、書いたことば',
    recentEmpty: '最近のことばは、まだありません。',
    recentWrite: 'ことばを書く',
    recentAll: 'ことばの一覧を見る',
    gatheredTitle: 'これまでの集まり',
    gatheredEmpty: '参加した集まりは、ここに残ります。',
    sessionsTitle: 'セッションの記録',
    sessionsLead: '運営から届いた音声です。何度でも聴き返せます。',
    sessionsEmpty: 'セッションの音声は、運営から届き次第、ここに残ります。',
    sessionsNoAudio: '音声は準備中です。',
    sessionBack15: '15秒戻る',
    sessionFwd15: '15秒進む',
    sessionSpeed: '再生速度',
    chapters: '章',
    settingsTitle: '設定とサポート',
    email: 'メールアドレスを変更',
    password: 'パスワードを変更',
    contact: '運営へのお問い合わせ',
    admin: '運営の管理画面（運営の方のみ）',
    logout: 'ログアウト',
    logoutConfirm: 'ログアウトしますか？',
    cancel: 'HAKU Communityを解約する',
    cancelConfirm: 'HAKU Communityを解約しますか？\n現在お支払い済みの期間の終了日まで引き続きご利用いただけます。以降の月額料金は発生しません。',
    cancelDone: '解約手続きを受け付けました。',
    cancelDoneUntil: '解約手続きを受け付けました。{date}まで引き続きご利用いただけます。',
    cancelFail: '解約処理に失敗しました。時間をおいて再度お試しください。',
    canceling: '解約手続き済みです。',
    cancelingUntil: '解約手続き済みです。{date}までご利用いただけます。',
    cancelUnknown: '解約の状況を読み込めませんでした。',
  },

  account: {
    emailTitle: 'メールアドレスを変更',
    emailNew: '新しいメールアドレス',
    emailPassword: '現在のパスワード（確認用）',
    emailSave: '保存する',
    emailSaving: '保存しています…',
    emailErrEmpty: 'メールアドレスを入力してください。',
    emailErrPassword: '現在のパスワードを入力してください。',
    emailDone: 'メールアドレスを変更しました。もう一度ログインしてください。',
    passwordTitle: 'パスワードを変更',
    passwordCurrent: '現在のパスワード',
    passwordNew: '新しいパスワード',
    passwordHint: '8文字以上でご設定ください。',
    passwordConfirm: '新しいパスワード（確認）',
    passwordSave: '変更する',
    passwordSaving: '変更しています…',
    passwordErrCurrent: '現在のパスワードを入力してください。',
    passwordErrShort: '新しいパスワードは8文字以上にしてください。',
    passwordErrMismatch: '確認用のパスワードが一致しません。',
    passwordDone: 'パスワードを変更しました。',
    back: 'わたしの記録へ戻る',
    changeFail: '変更できませんでした。時間をおいて再度お試しください。',
  },

  state: {
    loading: '読み込んでいます…',
    slow: '読み込みに時間がかかっています…',
    errNetwork: '通信できませんでした。',
    errTimeout: '読み込みに時間がかかりすぎています。',
    errServer: '読み込めませんでした。',
    errHint: '電波の良い場所で、もう一度お試しください。',
    retry: 'もう一度読み込む',
  },

  errors: {
    generic: '処理できませんでした。時間をおいて、もう一度お試しください。',
    session: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    network: '通信できませんでした。電波の良い場所で、もう一度お試しください。',
  },

  contact: {
    mailto: 'mailto:info@antagaorana.com?subject=HAKU%20Community%E3%81%B8%E3%81%AE%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B',
  },

  // 外部リンク（変更時はここだけ）。555チャレンジのMeetのURL。
  links: {
    challengeMeet: 'https://meet.google.com/cvr-kkda-mcg',
    adminPanel: '/haku-community/admin/',
    login: '/haku-community/login/',
  },
};

// {{t.a.b}} のドット区切りで文言を取り出す（見つからなければ例外。レンダリング時・テストで検知する）。
export function lookup(path) {
  const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), UI);
  if (typeof value !== 'string') throw new Error(`UI string not found: ${path}`);
  return value;
}
