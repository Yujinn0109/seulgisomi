// YouTube 채널·영상 통계 수집 → Supabase 저장
// GitHub Actions에서 매일 자동 실행됨
// 필요한 환경변수: YOUTUBE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const YT_KEY = process.env.YOUTUBE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// 모니터링할 채널 핸들
const CHANNELS = ['imos_jeonsomi', 'hi_sseulgi_'];

// 오늘 날짜 (KST 기준)
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const today = kst.toISOString().slice(0, 10);

async function yt(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', YT_KEY);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API ${endpoint} 실패: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabaseUpsert(table, rows, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table} 저장 실패: ${res.status} ${text}`);
  }
}

async function processChannel(handle) {
  console.log(`\n[${handle}] 처리 시작...`);

  // 1) 핸들 → 채널 ID + 통계
  const chData = await yt('channels', {
    part: 'snippet,statistics,contentDetails',
    forHandle: handle,
  });
  if (!chData.items || !chData.items.length) {
    console.log(`  ⚠️ 채널을 찾을 수 없음: ${handle}`);
    return;
  }
  const ch = chData.items[0];
  const stats = ch.statistics;
  const uploadsPlaylist = ch.contentDetails.relatedPlaylists.uploads;

  // 채널 스냅샷 저장
  await supabaseUpsert('channel_snapshots', [{
    channel_handle: handle,
    channel_title: ch.snippet.title,
    subscribers: parseInt(stats.subscriberCount) || 0,
    total_views: parseInt(stats.viewCount) || 0,
    video_count: parseInt(stats.videoCount) || 0,
    snapshot_date: today,
  }], 'channel_handle,snapshot_date');
  console.log(`  ✓ 채널 스냅샷: 구독자 ${stats.subscriberCount}, 총조회수 ${stats.viewCount}`);

  // 2) 최근 업로드 영상 15개 가져오기
  const playlistData = await yt('playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: uploadsPlaylist,
    maxResults: 15,
  });
  const videoIds = playlistData.items.map(i => i.contentDetails.videoId).join(',');

  // 3) 각 영상의 통계
  const videoData = await yt('videos', {
    part: 'snippet,statistics',
    id: videoIds,
  });

  const videoRows = videoData.items.map(v => ({
    channel_handle: handle,
    video_id: v.id,
    title: v.snippet.title,
    published_at: v.snippet.publishedAt,
    views: parseInt(v.statistics.viewCount) || 0,
    likes: parseInt(v.statistics.likeCount) || 0,
    comments: parseInt(v.statistics.commentCount) || 0,
    thumbnail: v.snippet.thumbnails?.medium?.url || '',
    snapshot_date: today,
  }));

  await supabaseUpsert('video_snapshots', videoRows, 'video_id,snapshot_date');
  console.log(`  ✓ 영상 스냅샷 ${videoRows.length}개 저장`);
}

async function main() {
  if (!YT_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('환경변수 누락: YOUTUBE_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY 확인');
  }
  console.log(`수집 날짜: ${today}`);
  for (const handle of CHANNELS) {
    try {
      await processChannel(handle);
    } catch (e) {
      console.error(`  ✗ [${handle}] 에러:`, e.message);
    }
  }
  console.log('\n완료!');
}

main().catch(e => { console.error(e); process.exit(1); });
