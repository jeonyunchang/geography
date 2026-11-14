/**
 * 세계지리 퀴즈 - Firebase Authentication + Cloud Firestore
 * 관리자 생성/수정/삭제 권한: firestore.rules 에 지정한 교사 UID 한 명.
 * 학생: 로그인하지 않고 published=true 문제만 조회하여 브라우저에서 채점.
 * 보안 참고: 공개 문제의 정답은 클라이언트에서 확인 가능합니다. 성적 평가용 비공개 정답 서버 아님.
 */
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const TOPICS = {climate:'기후',religion:'종교',population:'인구',country:'국가·지역'};
const LEVELS = {easy:'하',medium:'중',hard:'상'};
const TYPES = {choice:'객관식',ox:'OX',short:'단답형'};
const CHOICE_LABELS = ['①','②','③','④'];
const DB_COLLECTION = 'geography_quizzes';
const SDK_URL = 'https://www.gstatic.com/firebasejs/11.10.0/';
const state = {
  api:null, auth:null, db:null, connected:false, teacher:false,
  published:new Map(), managed:new Map(), unsubscribePublic:null,unsubscribeManaged:null,
  editId:null, attempt:null, authSeq:0
};
function showMessage(message, type='info') {
  const notice=$('qzNotice');notice.hidden=!message;
  notice.textContent=message||'';
  notice.style.borderLeftColor=type==='error'?'#cd514a':type==='success'?'#3d9660':'#dc9a41';
}
function errorMessage(e) {
  const code=e?.code||'';
  if(code.includes('permission-denied'))return '데이터 접근 권한이 없습니다. Firestore 규칙과 교사 UID를 확인해 주세요.';
  if(code.includes('auth/invalid-credential')||code.includes('auth/wrong-password')||code.includes('auth/user-not-found'))return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if(code.includes('auth/too-many-requests'))return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if(code.includes('auth/operation-not-allowed'))return 'Firebase Authentication에서 이메일/비밀번호 로그인 방식을 활성화해 주세요.';
  if(code.includes('auth/unauthorized-domain'))return 'Firebase Authentication 승인 도메인에 jeonyunchang.github.io 를 추가해 주세요.';
  if(code.includes('unavailable')||code.includes('network'))return '서버 연결에 실패했습니다. 네트워크 상태를 확인해 주세요.';
  return '작업을 완료하지 못했습니다. 연결 상태와 Firebase 설정을 확인해 주세요.';
}
function isHttpsImage(url) {
  if(!url)return false;
  try{return new URL(url).protocol==='https:';}catch{return false;}
}
function safeImage(url) {return isHttpsImage(url)?`<img class="qz-question-img" src="${escapeHtml(url)}" alt="문제 참고 이미지" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`:'';}
function setTeacherView(on) {
  state.teacher=Boolean(on);
  $('qzLoginBox').hidden=state.teacher;
  $('qzAdminPanel').hidden=!state.teacher;
  if(!state.teacher){state.managed.clear();state.editId=null;resetQuestionForm();}
}
function switchQuizMode(mode) {
  const student=mode==='student';
  $('qzStudentView').hidden=!student;
  $('qzTeacherView').hidden=student;
  $('qzStudentTab').classList.toggle('active',student);
  $('qzTeacherTab').classList.toggle('active',!student);
  $('qzStudentTab').setAttribute('aria-selected',String(student));
  $('qzTeacherTab').setAttribute('aria-selected',String(!student));
}
$('qzStudentTab').addEventListener('click',()=>switchQuizMode('student'));
$('qzTeacherTab').addEventListener('click',()=>switchQuizMode('teacher'));

function matchingQuestions() {
  const topic=$('qzTopicFilter').value,level=$('qzLevelFilter').value;
  return [...state.published.values()].filter(q=>(topic==='all'||q.topic===topic)&&(level==='all'||q.difficulty===level));
}
function renderAvailability() {
  const n=matchingQuestions().length;
  $('qzAvailable').textContent=state.connected?`현재 조건에 맞는 공개 문제: ${n}개`:'Firebase 연결 전입니다.';
  $('qzStart').disabled=!state.connected||n===0;
}
for(const id of ['qzTopicFilter','qzLevelFilter','qzCountFilter'])$(id).addEventListener('change',renderAvailability);

function shuffled(items){const arr=items.slice();for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
function startQuiz() {
  const pool=matchingQuestions();if(!pool.length)return;
  const count=$('qzCountFilter').value;
  const selected=shuffled(pool).slice(0,count==='all'?pool.length:Number(count));
  state.attempt={questions:selected,index:0,answers:{}};
  $('qzResult').hidden=true;
  $('qzPlay').hidden=false;
  $('qzPlay').scrollIntoView({block:'start',behavior:'smooth'});
  renderQuizQuestion();
}
$('qzStart').addEventListener('click',startQuiz);
function renderQuizQuestion() {
  const a=state.attempt;if(!a)return;
  const q=a.questions[a.index];if(!q)return;
  const val=a.answers[q.id]??'';
  const responses=q.type==='choice'?(q.options||[]).map((opt,i)=>`<button type="button" class="qz-answer ${val===String(i)?'is-selected':''}" data-answer="${i}" aria-pressed="${val===String(i)}"><span class="qz-answer-key">${CHOICE_LABELS[i]}</span> ${escapeHtml(opt)}</button>`).join(''):
    q.type==='ox'?['true','false'].map((v,i)=>`<button type="button" class="qz-answer ${val===v?'is-selected':''}" data-answer="${v}" aria-pressed="${val===v}"><span class="qz-answer-key">${i===0?'O':'X'}</span> ${i===0?'참':'거짓'}</button>`).join(''):
    `<label class="qz-field">정답 입력<input id="qzAnswerShort" class="qz-input" type="text" autocomplete="off" maxlength="300" placeholder="답을 입력하세요" value="${escapeHtml(val)}"></label>`;
  $('qzPlay').innerHTML=`<div class="qz-row"><span class="qz-chip">${escapeHtml(TOPICS[q.topic]||'지리')}</span><span class="qz-chip">난이도 ${escapeHtml(LEVELS[q.difficulty]||'중')}</span><strong>${a.index+1} / ${a.questions.length}</strong></div>
  <div class="qz-progress" role="progressbar" aria-label="문제 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((a.index+1)/a.questions.length*100)}"><span style="width:${((a.index+1)/a.questions.length*100).toFixed(1)}%"></span></div>
  <div class="qz-question">${escapeHtml(q.question)}</div>${safeImage(q.imageUrl)}
  <div class="qz-answer-list">${responses}</div>
  <div class="qz-row"><button type="button" class="button" data-quiz-nav="previous" ${a.index===0?'disabled':''}>이전 문제</button>
  <button type="button" class="button primary" data-quiz-nav="${a.index===a.questions.length-1?'finish':'next'}">${a.index===a.questions.length-1?'제출하고 채점하기':'다음 문제'}</button></div>`;
}
$('qzPlay').addEventListener('click',e=>{
  const answer=e.target.closest('button[data-answer]');
  if(answer){const a=state.attempt;if(!a)return;a.answers[a.questions[a.index].id]=answer.dataset.answer;renderQuizQuestion();return;}
  const nav=e.target.closest('button[data-quiz-nav]');if(!nav||!state.attempt)return;
  if(nav.dataset.quizNav==='previous'){state.attempt.index=Math.max(0,state.attempt.index-1);renderQuizQuestion();}
  else if(nav.dataset.quizNav==='next'){state.attempt.index=Math.min(state.attempt.questions.length-1,state.attempt.index+1);renderQuizQuestion();}
  else finishQuiz();
});
$('qzPlay').addEventListener('input',e=>{
  if(e.target.id==='qzAnswerShort'&&state.attempt){const a=state.attempt;a.answers[a.questions[a.index].id]=e.target.value;}
});
function normalizeAnswer(value){return String(value??'').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s\u200b\u3000.,!?·\-_'"“”‘’()（）]/g,'');}
function isCorrect(q,answer) {
  if(answer===undefined||answer===null||String(answer).trim()==='')return false;
  if(q.type==='short')return String(q.answer||'').split('|').some(v=>normalizeAnswer(v)===normalizeAnswer(answer));
  return String(q.answer)===String(answer);
}
function readableAnswer(q,ans) {
  if(ans===undefined||ans===null||String(ans).trim()==='')return '미응답';
  if(q.type==='choice')return (CHOICE_LABELS[Number(ans)]||'')+' '+(q.options?.[Number(ans)]||'');
  if(q.type==='ox')return ans==='true'?'O (참)':'X (거짓)';
  return String(ans);
}
function correctAnswer(q){return readableAnswer(q,String(q.answer||'').split('|')[0]);}
function finishQuiz() {
  const a=state.attempt;if(!a)return;
  const unanswered=a.questions.filter(q=>!String(a.answers[q.id]??'').trim()).length;
  if(unanswered&&!window.confirm(`미응답 문제 ${unanswered}개가 있습니다. 제출할까요?`))return;
  const score=a.questions.filter(q=>isCorrect(q,a.answers[q.id])).length;
  const feedback=a.questions.map((q,i)=>{
    const ok=isCorrect(q,a.answers[q.id]);
    return `<article class="qz-review ${ok?'correct':'wrong'}"><div class="qz-row"><strong>${i+1}. ${escapeHtml(q.question)}</strong><span class="qz-chip ${ok?'published':'draft'}">${ok?'정답':'오답'}</span></div>
      ${safeImage(q.imageUrl)}<p>내 답: ${escapeHtml(readableAnswer(q,a.answers[q.id]))}</p><p>정답: <b>${escapeHtml(correctAnswer(q))}</b></p><p><b>해설:</b> ${escapeHtml(q.explanation||'해설 없음').replace(/\n/g,'<br>')}</p></article>`;
  }).join('');
  $('qzResult').innerHTML=`<div class="qz-row"><div><h2>채점 결과</h2><p class="qz-help">답안과 해설을 확인해 보세요.</p></div><div class="qz-score">${score} / ${a.questions.length}</div></div>
    <p><b>정답률 ${Math.round(score/a.questions.length*100)}%</b></p><div>${feedback}</div>
    <div class="qz-row"><button type="button" id="qzRetry" class="button primary">새 문제 풀기</button><button type="button" id="qzBackFilters" class="button">조건 다시 선택</button></div>`;
  $('qzPlay').hidden=true;$('qzResult').hidden=false;
  $('qzResult').scrollIntoView({block:'start',behavior:'smooth'});
}
$('qzResult').addEventListener('click',e=>{
  if(e.target.closest('#qzRetry'))startQuiz();
  if(e.target.closest('#qzBackFilters')){$('qzResult').hidden=true;state.attempt=null;document.querySelector('#qzStudentView .qz-card')?.scrollIntoView({block:'start',behavior:'smooth'});}
});

function updateFormType(){
  const type=$('qzFormType').value;
  $('qzChoiceArea').hidden=type!=='choice';$('qzOxArea').hidden=type!=='ox';$('qzShortArea').hidden=type!=='short';
  for(let i=0;i<4;i++)$('qzOpt'+i).required=type==='choice';
  $('qzShortAnswer').required=type==='short';
}
$('qzFormType').addEventListener('change',updateFormType);
function resetQuestionForm(){
  $('qzQuestionForm').reset();state.editId=null;$('qzFormTitle').textContent='새 문제 출제';
  $('qzSave').textContent='문제 저장';$('qzCancelEdit').hidden=true;
  $('qzSaveMessage').textContent='';updateFormType();
}
$('qzCancelEdit').addEventListener('click',resetQuestionForm);
function gatherQuestion() {
  const type=$('qzFormType').value;
  const q={
    topic:$('qzFormTopic').value,difficulty:$('qzFormLevel').value,type,
    question:$('qzFormQuestion').value.trim(),explanation:$('qzFormExplanation').value.trim(),
    published:$('qzFormPublished').checked,
    imageUrl:$('qzFormImage').value.trim(),
    options:type==='choice'?[0,1,2,3].map(i=>$('qzOpt'+i).value.trim()):[],
    answer:type==='choice'?$('qzChoiceAnswer').value:type==='ox'?$('qzOxAnswer').value:$('qzShortAnswer').value.trim()
  };
  if(!q.question||!q.explanation)throw new Error('문제 내용과 해설을 입력해 주세요.');
  if(q.type==='choice'&&(q.options.some(v=>!v)||new Set(q.options.map(normalizeAnswer)).size!==4))throw new Error('객관식 보기 네 개를 서로 다르게 작성해 주세요.');
  if(q.type==='short'&&(!q.answer||q.answer.split('|').some(s=>!s.trim())))throw new Error('단답형 정답을 올바르게 입력해 주세요.');
  if(q.imageUrl&&!isHttpsImage(q.imageUrl))throw new Error('이미지 주소는 https://로 시작해야 합니다.');
  return q;
}
$('qzQuestionForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.teacher||!state.connected)return;
  let question;try{question=gatherQuestion();}catch(error){$('qzSaveMessage').textContent=error.message;return;}
  const button=$('qzSave');button.disabled=true;$('qzSaveMessage').textContent='저장 중...';
  try{
    const api=state.api,ref=api.collection(state.db,DB_COLLECTION);
    if(state.editId){await api.updateDoc(api.doc(ref,state.editId),{...question,updatedAt:api.serverTimestamp()});}
    else {await api.addDoc(ref,{...question,createdAt:api.serverTimestamp(),updatedAt:api.serverTimestamp()});}
    resetQuestionForm();$('qzSaveMessage').textContent='저장했습니다. 공개 여부에 따라 학생에게 표시됩니다.';
  }catch(err){console.error('문제 저장 실패',err);$('qzSaveMessage').textContent=errorMessage(err);}
  finally{button.disabled=false;}
});
function loadQuestionToForm(id) {
  const q=state.managed.get(id);if(!q)return;
  state.editId=id;$('qzFormTitle').textContent='문제 수정';$('qzSave').textContent='수정 저장';$('qzCancelEdit').hidden=false;
  $('qzFormTopic').value=q.topic;$('qzFormLevel').value=q.difficulty;$('qzFormType').value=q.type;
  $('qzFormQuestion').value=q.question||'';$('qzFormExplanation').value=q.explanation||'';
  $('qzFormImage').value=q.imageUrl||'';$('qzFormPublished').checked=Boolean(q.published);
  for(let i=0;i<4;i++)$('qzOpt'+i).value=q.options?.[i]||'';
  $('qzChoiceAnswer').value=q.type==='choice'?String(q.answer):'0';
  $('qzOxAnswer').value=q.type==='ox'?q.answer:'true';$('qzShortAnswer').value=q.type==='short'?q.answer:'';
  updateFormType();$('qzSaveMessage').textContent='이 문제를 수정하고 있어요.';
  $('qzFormCard').scrollIntoView({behavior:'smooth',block:'start'});
}
function questionSort(a,b){
  const ay=a.updatedAt?.toMillis?.()||0,by=b.updatedAt?.toMillis?.()||0;
  return by-ay||a.question.localeCompare(b.question,'ko');
}
function renderAdminList() {
  const questions=[...state.managed.values()].sort(questionSort);
  $('qzTotalCount').textContent=`(${questions.length}개 · 공개 ${questions.filter(q=>q.published).length}개)`;
  const status=$('qzManageFilter').value,keyword=$('qzManageSearch').value.trim().toLocaleLowerCase('ko-KR');
  const selected=questions.filter(q=>(status==='all'||(status==='published')===Boolean(q.published))&&(!keyword||q.question.toLocaleLowerCase('ko-KR').includes(keyword)));
  $('qzQuestionList').innerHTML=selected.length?selected.map(q=>`<article class="qz-item">
    <span class="qz-chip">${escapeHtml(TOPICS[q.topic]||'지리')}</span><span class="qz-chip">${escapeHtml(LEVELS[q.difficulty]||'중')}</span>
    <span class="qz-chip">${escapeHtml(TYPES[q.type]||'기타')}</span><span class="qz-chip ${q.published?'published':'draft'}">${q.published?'공개 중':'비공개 초안'}</span>
    <h4>${escapeHtml(q.question)}</h4><p class="qz-help">정답: ${escapeHtml(correctAnswer(q))}</p>
    <div class="qz-row"><button class="button" type="button" data-qz-admin="edit" data-id="${escapeHtml(q.id)}">수정</button>
    <button class="button" type="button" data-qz-admin="publish" data-id="${escapeHtml(q.id)}">${q.published?'비공개 전환':'공개하기'}</button>
    <button class="button" type="button" data-qz-admin="delete" data-id="${escapeHtml(q.id)}">삭제</button></div></article>`).join(''):'<p class="qz-help">조건에 맞는 문제가 없습니다. 위에서 새 문제를 등록해 보세요.</p>';
}
$('qzManageFilter').addEventListener('change',renderAdminList);
$('qzManageSearch').addEventListener('input',renderAdminList);
$('qzQuestionList').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-qz-admin]');if(!b||!state.teacher)return;
  const id=b.dataset.id,action=b.dataset.qzAdmin,q=state.managed.get(id);if(!q)return;
  if(action==='edit'){loadQuestionToForm(id);return;}
  if(action==='delete'&&!window.confirm('이 문제를 완전히 삭제할까요? 삭제하면 복구할 수 없습니다.'))return;
  b.disabled=true;
  try{
    const docRef=state.api.doc(state.db,DB_COLLECTION,id);
    if(action==='publish')await state.api.updateDoc(docRef,{published:!q.published,updatedAt:state.api.serverTimestamp()});
    else if(action==='delete'){await state.api.deleteDoc(docRef);if(state.editId===id)resetQuestionForm();}
  }catch(err){window.alert(errorMessage(err));b.disabled=false;}
});

$('qzLoginForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.connected||!state.auth)return;
  $('qzLoginMessage').textContent='로그인 확인 중...';
  const button=e.submitter||$('qzLoginForm').querySelector('button[type=submit]');button.disabled=true;
  try{await state.api.signInWithEmailAndPassword(state.auth,$('qzEmail').value.trim(),$('qzPassword').value);$('qzPassword').value='';}
  catch(error){$('qzLoginMessage').textContent=errorMessage(error);}
  finally{button.disabled=false;}
});
$('qzLogout').addEventListener('click',async()=>{
  if(!state.auth)return;
  try{await state.api.signOut(state.auth);$('qzLoginMessage').textContent='로그아웃했습니다.';}
  catch(error){window.alert(errorMessage(error));}
});

async function verifyTeacher(user) {
  const seq=++state.authSeq;
  if(state.unsubscribeManaged){state.unsubscribeManaged();state.unsubscribeManaged=null;}
  setTeacherView(false);
  if(!user)return;
  $('qzLoginMessage').textContent='교사 권한 확인 중...';
  try{
    // 보안 규칙에 등록된 교사 UID라면 공개 여부와 관계없이 목록 조회 가능.
    // 일반 계정은 공개 필터 없는 쿼리가 거부됨. 단순 버튼 숨김이 아닌 서버 검사.
    await state.api.getDocs(state.api.query(state.api.collection(state.db,DB_COLLECTION),state.api.limit(1)));
    if(seq!==state.authSeq||state.auth.currentUser?.uid!==user.uid)return;
    setTeacherView(true);$('qzLoginMessage').textContent='';
    state.unsubscribeManaged=state.api.onSnapshot(state.api.collection(state.db,DB_COLLECTION),snap=>{
      state.managed=new Map(snap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));renderAdminList();
    },err=>{showMessage(errorMessage(err),'error');console.error('관리 목록 조회 실패:',err)});
  }catch(error){
    if(seq!==state.authSeq)return;
    console.warn('관리 권한 확인 실패:',error);
    $('qzLoginMessage').textContent='교사 권한이 확인되지 않았습니다. Firestore 규칙에 지정된 UID인지 확인해 주세요.';
    try{await state.api.signOut(state.auth);}catch(e){console.warn(e);}
  }
}

async function connectFirebase() {
  if(!firebaseConfig.apiKey||firebaseConfig.apiKey.includes('PASTE_')||!firebaseConfig.projectId||firebaseConfig.projectId==='PASTE_PROJECT_ID'){
    $('qzConnection').textContent='초기 설정 필요';
    showMessage('퀴즈 기능을 사용하려면 교사가 firebase-config.js에 Firebase 웹 앱 설정을 입력하고 firestore.rules를 적용해야 합니다. README_설치방법.md를 참고하세요.');
    return;
  }
  try{
    const [app,auth,firestore]=await Promise.all([
      import(SDK_URL+'firebase-app.js'),import(SDK_URL+'firebase-auth.js'),import(SDK_URL+'firebase-firestore.js')
    ]);
    state.api={...app,...auth,...firestore};
    const firebaseApp=app.initializeApp(firebaseConfig);
    state.auth=auth.getAuth(firebaseApp);state.db=firestore.getFirestore(firebaseApp);
    state.connected=true;$('qzConnection').textContent='Firebase 연결됨';showMessage('');
    state.unsubscribePublic=firestore.onSnapshot(
      firestore.query(firestore.collection(state.db,DB_COLLECTION),firestore.where('published','==',true)),
      snap=>{state.published=new Map(snap.docs.map(d=>[d.id,{id:d.id,...d.data()}]));renderAvailability();},
      err=>{console.error('공개 문제 조회 실패:',err);showMessage(errorMessage(err),'error');}
    );
    auth.onAuthStateChanged(state.auth,user=>{void verifyTeacher(user);});
    renderAvailability();
  }catch(err){console.error('Firebase 초기화 오류:',err);$('qzConnection').textContent='연결 실패';showMessage(errorMessage(err)+' (초기화 실패)','error');}
}
updateFormType();renderAvailability();void connectFirebase();
