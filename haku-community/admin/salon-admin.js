/* 灯サロン運営（管理画面の「灯 サロン運営」タブ）。api/admin.js の salon-* アクションだけを呼ぶ。
   権限はサーバー側で判定する（管理者ログイン＋灯の運営ロール）。この画面側の表示切替は案内のためだけ。 */
(function () {
  var CH = [['home', 'ホーム'], ['creed', '今月の一条'], ['case', 'ケース検討'], ['mgmt', '運営の相談'], ['archive', '実践講義アーカイブ'], ['news', 'お知らせ']];
  var body, msg, sub = 'applications', state = { ch: 'home', appStatus: 'pending' }, keepMsg = false;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmt(ms) { if (!ms) return ''; var d = new Date(ms + 9 * 3600 * 1000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
  function localInput(ms) { if (!ms) return ''; return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 16); }
  function fromLocal(v) { return v ? Date.parse(v + ':00+09:00') : null; }
  function say(t, ok) { msg.textContent = t || ''; msg.style.color = ok ? '#2f5a3a' : '#9A3B1F'; }

  function call(action, payload, query) {
    var q = '/api/admin?action=' + action + (query || '');
    var opts = payload === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(payload) };
    return api(q, opts).then(function (res) {
      if (res.status === 401) { say('ログインの有効期限が切れました。画面を再読み込みしてください。'); throw new Error('401'); }
      if (res.status !== 200) { say(res.data.error || '処理できませんでした。'); throw new Error('ng'); }
      if (keepMsg) keepMsg = false; else say('');
      return res.data;
    });
  }
  function on(root, sel, ev, fn) { root.querySelectorAll(sel).forEach(function (el) { el.addEventListener(ev, function (e) { fn(el, e); }); }); }
  function val(id) { return document.getElementById(id).value; }
  function done(t) { say(t, true); keepMsg = true; } // 直後の再読み込みの通信で、成功の表示が消えないようにする

  // ── 運営ロール ──
  function viewRoles() {
    call('salon-staff-list').then(function (d) {
      var h = '<p class="note">灯の運営ロール（大久保先生・事務局）に登録された管理者だけが、灯の投稿・会員の管理を行えます。HAKU Communityの管理者というだけでは、灯の内容は見られません。</p>';
      h += d.you ? '<p class="note">あなたのロール：<b>' + esc(d.you.title || d.you.role) + '</b></p>'
        : d.canEditStaff ? '<p class="note" style="color:#9A3B1F">あなた（最高管理者）は、まだ灯の運営ロールに登録されていません。下のフォームに、ご自身のメールアドレスが入っています。ロールを選んで「登録・更新する」を押すと、灯の申請・投稿などを操作できます。</p>'
        : '<p class="note" style="color:#9A3B1F">あなたは灯の運営ロールに登録されていません。最高管理者に登録を依頼してください。</p>';
      h += (d.staff || []).map(function (s) { return '<div class="app"><b>' + esc(s.email) + '</b><div class="meta">' + esc(s.role === 'owner' ? '代表' : '事務局') + '／表示：' + esc(s.title || '') + (s.subtitle ? '・' + esc(s.subtitle) : '') + '</div>' + (d.canEditStaff ? '<div class="row"><button class="reject" data-rm="' + esc(s.email) + '">ロールを外す</button></div>' : '') + '</div>'; }).join('') || '<div class="empty">登録されている運営ロールはありません。</div>';
      if (d.canEditStaff) {
        h += '<div class="evform"><label for="stEmail">管理者のメールアドレス</label><input type="email" id="stEmail"><div class="row2"><div><label for="stRole">ロール</label><select id="stRole"><option value="owner">代表（owner）</option><option value="secretariat">事務局（secretariat）</option></select></div><div><label for="stTitle">表示名（バッジ）</label><input type="text" id="stTitle" placeholder="代表／事務局"></div></div><label for="stSub">補足（任意）</label><input type="text" id="stSub"><button class="submit" id="stGo">登録・更新する</button></div>';
      } else h += '<p class="note">運営ロールの追加・削除は、最高管理者のみ行えます。</p>';
      body.innerHTML = h;
      on(body, '[data-rm]', 'click', function (el) { if (confirm(el.dataset.rm + ' のロールを外しますか？')) call('salon-staff-set', { email: el.dataset.rm, role: 'none' }).then(function () { done('外しました。'); viewRoles(); }, function () {}); });
      if (d.canEditStaff && !d.you && d.actor && /@/.test(d.actor)) { var em = document.getElementById('stEmail'); if (em) { em.value = d.actor; document.getElementById('stRole').value = 'secretariat'; document.getElementById('stTitle').value = '事務局'; } }
      var go = document.getElementById('stGo');
      if (go) go.addEventListener('click', function () { call('salon-staff-set', { email: val('stEmail'), role: val('stRole'), title: val('stTitle'), subtitle: val('stSub') }).then(function () { done('登録しました。'); viewRoles(); }, function () {}); });
    }, function () {});
  }

  // ── 今月の一条 ──
  function viewCreed() {
    call('salon-creed-get').then(function (d) {
      var cur = d.current;
      var h = '<p class="note">サロンの「今月の一条」を設定します（文言は十ヶ条の定めのものが入ります）。' + (cur ? '現在：<b>' + esc((d.creeds[cur.n - 1] || {}).label || '') + '</b>' + (cur.reading ? '｜' + esc(cur.reading) : '') : '現在：未設定') + '</p>';
      h += '<div class="evform"><label for="crN">条</label><select id="crN">' + d.creeds.map(function (c) { return '<option value="' + c.n + '"' + (cur && cur.n === c.n ? ' selected' : '') + '>' + esc(c.label + ' ' + c.title) + '</option>'; }).join('') + '</select><label for="crR">今月の読み方（任意・80字まで）</label><input type="text" id="crR" value="' + esc(cur && cur.reading || '') + '"><button class="submit" id="crGo">この条に設定する</button></div>';
      body.innerHTML = h;
      document.getElementById('crGo').addEventListener('click', function () { call('salon-creed-set', { n: Number(val('crN')), reading: val('crR') }).then(function () { done('設定しました。'); viewCreed(); }, function () {}); });
    }, function () {});
  }

  // ── 投稿・コメント ──
  function viewPosts() {
    var h = '<p class="note">投稿とコメントの確認・削除・ピン留めができます。匿名投稿の投稿者は、ここにも表示されません。</p><div class="statusfilter">' + CH.map(function (c) { return '<button data-ch="' + c[0] + '"' + (state.ch === c[0] ? ' class="on"' : '') + '>' + c[1] + '</button>'; }).join('') + '</div><div id="slPosts"><div class="empty">読み込み中…</div></div>';
    body.innerHTML = h;
    on(body, '[data-ch]', 'click', function (el) { state.ch = el.dataset.ch; viewPosts(); });
    call('salon-posts', undefined, '&ch=' + state.ch).then(function (d) {
      var box = document.getElementById('slPosts');
      box.innerHTML = (d.posts || []).map(function (p) {
        return '<div class="post" data-id="' + esc(p.id) + '"><div class="meta">' + esc(p.author && p.author.label || '') + '・' + esc(p.channelLabel) + '・' + fmt(p.createdAt) + (p.creedTag ? '・' + esc(p.creedLabel) : '') + (p.pinned ? '<span class="hidden-badge" style="color:#8a5a1f;border-color:#8a5a1f">ピン留め</span>' : '') + '</div><div class="body">' + esc(p.body) + '</div><div class="row"><button data-pin="' + (p.pinned ? '0' : '1') + '">' + (p.pinned ? 'ピン留めを外す' : 'ピン留めする') + '</button><button data-cm>コメント(' + p.commentCount + ')を見る</button><button class="danger" data-del>削除</button></div><div class="cms"></div></div>';
      }).join('') || '<div class="empty">投稿はありません。</div>';
      on(box, '[data-pin]', 'click', function (el) { var id = el.closest('.post').dataset.id; var title = el.dataset.pin === '1' ? (prompt('ピン留めの見出し（40字まで・空でも可）', '') || '') : undefined; call('salon-post-pin', { id: id, pinned: el.dataset.pin === '1', pinTitle: title }).then(function () { done('更新しました。'); viewPosts(); }, function () {}); });
      on(box, '[data-del]', 'click', function (el) { if (confirm('この投稿を削除します（コメントも消えます）。元に戻せません。よろしいですか？')) call('salon-post-delete', { id: el.closest('.post').dataset.id }).then(function () { done('削除しました。'); viewPosts(); }, function () {}); });
      on(box, '[data-cm]', 'click', function (el) {
        var post = el.closest('.post'), cms = post.querySelector('.cms');
        call('salon-comments', undefined, '&postId=' + encodeURIComponent(post.dataset.id)).then(function (c) {
          cms.innerHTML = (c.comments || []).map(function (x) { return '<div class="audit" style="margin-left:' + (x.depth - 1) * 18 + 'px" data-cid="' + esc(x.id) + '"><b>' + esc(x.author && x.author.label || '') + '</b> <span class="meta">' + fmt(x.createdAt) + '</span><div>' + esc(x.body) + '</div><button class="danger" data-cdel style="margin-top:6px;padding:3px 10px;font-size:11.5px;border:1px solid #9A3B1F;background:#fff;color:#9A3B1F;cursor:pointer">削除</button></div>'; }).join('') || '<div class="meta">コメントはありません。</div>';
          on(cms, '[data-cdel]', 'click', function (b) { if (confirm('このコメントと、その返信を削除します。よろしいですか？')) call('salon-comment-delete', { id: b.closest('[data-cid]').dataset.cid }).then(function () { done('削除しました。'); el.click(); }, function () {}); });
        }, function () {});
      });
    }, function () {});
  }

  // ── 講義アーカイブ ──
  function viewLectures() {
    call('salon-lecture-list').then(function (d) {
      var h = '<p class="note">実践講義の動画を登録します。動画のURLは会員にだけ返され、一般には公開されません。動画素材・配信方法は未確定のため、YouTube限定公開／Vimeo／mp4の https:// URLのいずれかを指定します。</p>';
      h += '<div class="evform"><label for="lcT">タイトル</label><input type="text" id="lcT"><div class="row2"><div><label for="lcD">開催日</label><input type="date" id="lcD"></div><div><label for="lcM">長さ（分）</label><input type="number" id="lcM" min="1" max="599"></div></div><label for="lcU">動画URL（https://）</label><input type="text" id="lcU"><label for="lcN">一言メモ（任意）</label><input type="text" id="lcN"><label for="lcS">説明（任意）</label><textarea id="lcS" rows="3"></textarea><button class="submit" id="lcGo">登録して、アーカイブに投稿する</button></div>';
      h += (d.lectures || []).map(function (l) { return '<div class="ev" data-id="' + esc(l.id) + '"><b>' + esc(l.title) + '</b><div class="meta">' + fmt(l.heldAt) + (l.minutes ? '・' + l.minutes + '分' : '') + '</div><div class="row" style="margin-top:8px"><button class="danger" data-ld style="padding:5px 12px;border:1px solid #9A3B1F;background:#fff;color:#9A3B1F;cursor:pointer;font-size:12px">削除</button></div></div>'; }).join('') || '<div class="empty">登録された講義はありません。</div>';
      body.innerHTML = h;
      document.getElementById('lcGo').addEventListener('click', function () {
        call('salon-lecture-create', { title: val('lcT'), heldAt: val('lcD') ? Date.parse(val('lcD') + 'T12:00:00+09:00') : null, minutes: val('lcM'), videoUrl: val('lcU'), note: val('lcN'), description: val('lcS') }).then(function () { done('登録しました。'); viewLectures(); }, function () {});
      });
      on(body, '[data-ld]', 'click', function (el) { if (confirm('この講義と、アーカイブの投稿を削除します。よろしいですか？')) call('salon-lecture-delete', { id: el.closest('[data-id]').dataset.id }).then(function () { done('削除しました。'); viewLectures(); }, function () {}); });
    }, function () {});
  }

  // ── お知らせ・イベント ──
  function viewEvents() {
    call('salon-event-list').then(function (d) {
      var h = '<p class="note">サロンのお知らせと、今月の予定（イベント）を管理します。開催URL（Google Meetなど）の運用は未確定のため、必要なときだけ https:// のURLを入れてください。URLは参加表明した会員にだけ表示されます。</p>';
      h += '<div class="evform"><b style="font-size:13px">お知らせを投稿</b><label for="nwB">本文</label><textarea id="nwB" rows="3"></textarea><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="nwP" style="width:auto"> ピン留めする</label><button class="submit" id="nwGo">お知らせを投稿する</button></div>';
      h += '<div class="evform"><b style="font-size:13px">イベントを作成</b><label for="evT2">タイトル</label><input type="text" id="evT2"><div class="row2"><div><label for="evS2">開催日時</label><input type="datetime-local" id="evS2"></div><div><label for="evC2">定員（任意）</label><input type="number" id="evC2" min="1"></div></div><label for="evM2">ひとこと（任意）</label><input type="text" id="evM2"><label for="evU2">開催URL（任意・https://）</label><input type="text" id="evU2"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="evA2" style="width:auto"> お知らせにも投稿する</label><button class="submit" id="evGo2">イベントを作成する</button></div>';
      h += (d.events || []).map(function (e) { return '<div class="ev" data-id="' + esc(e.id) + '"><b>' + esc(e.title) + '</b><div class="meta">' + fmt(e.startsAt) + '・参加表明 ' + e.participants + '名' + (e.capacity ? '／定員' + e.capacity : '') + (e.url ? '・URL設定済み' : '') + '</div><div class="row" style="margin-top:8px"><button data-ep style="padding:5px 12px;border:1px solid #33472f;background:#fff;color:#33472f;cursor:pointer;font-size:12px">参加者</button> <button data-ed style="padding:5px 12px;border:1px solid #9A3B1F;background:#fff;color:#9A3B1F;cursor:pointer;font-size:12px">削除</button></div><div class="pl meta"></div></div>'; }).join('') || '<div class="empty">イベントはありません。</div>';
      body.innerHTML = h;
      document.getElementById('nwGo').addEventListener('click', function () { call('salon-news-create', { body: val('nwB'), pinned: document.getElementById('nwP').checked }).then(function () { done('投稿しました。'); viewEvents(); }, function () {}); });
      document.getElementById('evGo2').addEventListener('click', function () {
        call('salon-event-create', { title: val('evT2'), startsAt: fromLocal(val('evS2')), capacity: val('evC2') || null, summary: val('evM2'), url: val('evU2') || undefined, announce: document.getElementById('evA2').checked }).then(function () { done('作成しました。'); viewEvents(); }, function () {});
      });
      on(body, '[data-ed]', 'click', function (el) { if (confirm('このイベントを削除します。よろしいですか？')) call('salon-event-delete', { id: el.closest('[data-id]').dataset.id }).then(function () { done('削除しました。'); viewEvents(); }, function () {}); });
      on(body, '[data-ep]', 'click', function (el) { var box = el.closest('[data-id]'); call('salon-event-participants', undefined, '&id=' + encodeURIComponent(box.dataset.id)).then(function (p) { box.querySelector('.pl').textContent = (p.participants || []).map(function (x) { return x.name; }).join('、') || '参加表明はまだありません。'; }, function () {}); });
    }, function () {});
  }

  // ── 申請・決済（申請の確認 → 承認／却下 → お支払い状況） ──
  var PAY = { review: '審査中', unpaid: '未決済（お支払い待ち）', paid: '決済済み（Stripe）', exempt: '決済免除（運営が有効化）', none: '—' };
  var MEM = { active: '有効', canceling: '解約予約中（期間の終わりまで利用可）', past_due: 'お支払い遅れ（利用停止中）', canceled: '解約済み', inactive: '無効' };
  var APP = { pending: '審査中', approved: '承認済み', paid: '承認済み', rejected: '却下' };
  function dateOnly(ms) { if (!ms) return ''; var d = new Date(ms + 9 * 3600 * 1000); return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); }
  function viewApplications() {
    var f = state.appStatus;
    var h = '<p class="note">灯サロンの申請管理です。承認すると、お支払いのご案内（月額2,980円・Stripe）を本人へ送ります。承認前はお支払いできません。お支払いが確認されると（Stripe Webhook）、自動で会員になります。会員資格・決済状況は、「会員一覧・検索」でも確認できます。</p><div class="statusfilter">' + [['pending', '審査中'], ['approved', '承認済み'], ['rejected', '却下'], ['all', 'すべて']].map(function (x) { return '<button data-af="' + x[0] + '"' + (f === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>'; }).join('') + '</div><div id="slApps"><div class="empty">読み込み中…</div></div>';
    body.innerHTML = h;
    on(body, '[data-af]', 'click', function (el) { state.appStatus = el.dataset.af; viewApplications(); });
    call('salon-applications', undefined, '&status=' + f).then(function (d) {
      var box = document.getElementById('slApps');
      box.innerHTML = (d.applications || []).map(function (a) {
        var st = a.application === 'paid' ? 'approved' : a.application;
        var meta = esc(a.email) + '｜申請：' + fmt(a.submittedAt) + (a.referrerName ? '｜紹介者：' + esc(a.referrerName) : '') + (a.prefecture ? '｜' + esc(a.prefecture) : '') + (a.facilityLabel ? '｜' + esc(a.facilityLabel) : '');
        var pay = '<div class="meta">申請：<b style="display:inline">' + esc(APP[a.application] || a.application) + '</b>｜お支払い：<b style="display:inline" data-pay="' + esc(a.payment) + '">' + esc(PAY[a.payment] || a.payment) + '</b>' + (a.membership ? '｜会員資格：' + esc(MEM[a.membership] || a.membership) : '') + (a.hasSubscription ? '｜月額契約あり' : '') + (a.currentPeriodEnd ? '｜期間の終わり：' + dateOnly(a.currentPeriodEnd) : '') + (a.exemptReason ? '｜免除の理由：' + esc(a.exemptReason) : '') + '</div>';
        var btns = a.application === 'pending' ? '<div class="row"><button class="approve" data-ap="approve">承認する</button><button class="reject" data-ap="reject">却下する</button></div>'
          : (a.application === 'approved' && a.payment === 'unpaid') ? '<div class="row"><button data-ap="link">お支払いのご案内を再送する</button></div>' : '';
        return '<div class="app" data-email="' + esc(a.email) + '"><span class="cat st-' + esc(st) + '">' + esc(APP[a.application] || a.application) + '</span><b>' + esc(a.fullName) + '（' + esc(a.displayName) + '）</b><div class="meta">' + meta + '</div><div class="reason">' + esc(a.reason) + '</div>' + pay + btns + '</div>';
      }).join('') || '<div class="empty">該当する申請はありません。</div>';
      on(box, '[data-ap]', 'click', function (el) {
        var email = el.closest('[data-email]').dataset.email, act = el.dataset.ap;
        var q = act === 'approve' ? email + ' を承認し、お支払いのご案内を送ります。よろしいですか？' : act === 'reject' ? email + ' を却下します。よろしいですか？' : email + ' へ、お支払いのご案内を再送します。よろしいですか？';
        if (!confirm(q)) return;
        el.disabled = true; // 二重操作を防ぐ
        call(act === 'approve' ? 'salon-application-approve' : act === 'reject' ? 'salon-application-reject' : 'salon-payment-link', { email: email }).then(function (r) {
          var verb = act === 'approve' ? '承認しました。' : '送信しました。';
          var t = act === 'reject' ? '却下しました。' : (r.emailSent === false ? verb + 'ただし、メールの送信に失敗しました。「お支払いのご案内を再送する」を押してください。' : r.checkout === 'fallback' ? verb + '決済の設定が未完了のため、ログイン画面から進むご案内を送りました。' : verb + 'お支払いのご案内を送りました。');
          done(t); viewApplications();
        }, function () { el.disabled = false; });
      });
    }, function () {});
  }

  // ── 会員（会員資格の状態。決済を経ない手動の有効化は、理由つきで記録される） ──
  function viewMembers() {
    call('salon-overview').then(function (o) {
      return call('salon-members').then(function (m) { return { o: o, m: m }; });
    }).then(function (r) {
      var h = '<p class="note">申請数 ' + r.o.applications + '／審査中 ' + r.o.pending + '／有効会員 ' + r.o.activeMembers + '／運営ロール ' + r.o.staff + '／投稿 ' + r.o.posts + '。審査（承認・却下）と、お支払いのご案内は「申請・決済」で行います。会員資格はお支払い（Stripe）の確認で自動的に変わります。招待・テストなどで決済を経ずに有効にするときだけ、下の操作を使います（理由が記録に残ります）。</p>';
      h += (r.m.members || []).map(function (x) {
        var manual = (x.application === 'approved' || x.application === 'paid') && !(x.hasSubscription && ['active', 'canceling', 'past_due'].indexOf(x.membership) >= 0);
        return '<div class="app" data-email="' + esc(x.email) + '"><b>' + esc(x.name || '(名前なし)') + (x.role ? '（運営：' + esc(x.role) + '）' : '') + '</b><div class="meta">' + esc(x.email) + '｜申請：' + esc(APP[x.application] || x.application) + '｜お支払い：' + esc(PAY[x.payment] || x.payment) + '｜会員状態：' + esc(MEM[x.membership] || x.membership || '未設定') + (x.currentPeriodEnd ? '｜期間の終わり：' + dateOnly(x.currentPeriodEnd) : '') + (x.prefecture ? '｜' + esc(x.prefecture) : '') + '</div>' + (manual ? '<div class="row"><button data-st="active">決済を免除して有効にする</button><button class="reject" data-st="inactive">無効にする</button></div>' : '') + '</div>';
      }).join('') || '<div class="empty">申請はまだありません。</div>';
      body.innerHTML = h;
      on(body, '[data-st]', 'click', function (el) {
        var email = el.closest('[data-email]').dataset.email;
        var reason = prompt(email + ' を「' + (el.dataset.st === 'active' ? '決済を免除して有効' : '無効') + '」にします。理由を入力してください（記録に残ります）。', '');
        if (!reason) return;
        call('salon-member-set', { email: email, status: el.dataset.st, reason: reason }).then(function () { done('更新しました。'); viewMembers(); }, function () {});
      });
    }, function () {});
  }

  // ── 操作履歴 ──
  function viewAudit() {
    call('salon-audit').then(function (d) {
      body.innerHTML = '<p class="note">灯に関する運営の操作履歴（直近）です。</p>' + ((d.entries || []).map(function (e) { return '<div class="audit"><b>' + esc(String(e.action || '').replace('salon_', '')) + '</b> ' + esc(e.actorId || '') + ' <span class="meta">' + esc(e.targetId || '') + '・' + fmt(e.createdAt || e.at || e.timestamp) + '</span></div>'; }).join('') || '<div class="empty">履歴はありません。</div>');
    }, function () {});
  }

  // 「会員」は、管理メニューの「会員管理 › 灯サロン › 会員一覧・検索」に集約した（画面側の viewMembers は使わない）
  var VIEWS = { applications: viewApplications, roles: viewRoles, creed: viewCreed, posts: viewPosts, lectures: viewLectures, events: viewEvents, audit: viewAudit };
  function show(name) {
    sub = name;
    window.dispatchEvent(new CustomEvent('salon-sub', { detail: name })); // 管理メニューの選択表示を合わせる
    document.querySelectorAll('#salonSub button').forEach(function (b) { b.classList.toggle('on', b.dataset.sub === name); });
    body.innerHTML = '<div class="empty">読み込み中…</div>';
    VIEWS[name]();
  }

  window.SalonAdmin = {
    open: function (requested) {
      if (requested && VIEWS[requested]) sub = requested;
      body = document.getElementById('salonBody'); msg = document.getElementById('salonMsg');
      var bar = document.getElementById('salonSub');
      if (!bar.querySelector('[data-sub="applications"]')) { // 「申請・決済」を先頭に追加する（管理画面のHTMLは変えず、ここで足す）
        var b0 = document.createElement('button'); b0.dataset.sub = 'applications'; b0.textContent = '申請・決済';
        bar.insertBefore(b0, bar.firstChild);
      }
      if (!document.getElementById('salonSub').dataset.bound) {
        document.getElementById('salonSub').dataset.bound = '1';
        document.querySelectorAll('#salonSub button').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.sub); }); });
      }
      call('salon-staff-list').then(function (d) { show(d.you ? sub : 'roles'); }, function () { show(sub); });
    }
  };
})();
