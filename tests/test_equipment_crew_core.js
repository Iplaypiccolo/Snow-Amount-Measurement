const assert=require('node:assert/strict'),C=require('../equipment/js/crew.js');
const tests=[];function test(name,fn){try{fn();tests.push([name,true]);}catch(e){tests.push([name,false,e.message]);}}
test('운전원26·정비원14 코드 목록',()=>{assert.equal(C.drivers.length,26);assert.equal(C.mechanics.length,14);assert.equal(C.mechanics.at(-1),'하');});
test('역할 혼합 두 명·빈 선택 허용',()=>{assert.ok(C.valid(['a','마']));assert.ok(C.valid([]));assert.ok(C.valid(['z','하']));});
test('중복·세 명·유효하지 않은 코드 차단',()=>{for(const a of [['a','a'],['a','b','c'],['A'],['힣'],[null],null])assert.ok(!C.valid(a));});
test('기계화부·지원·첫날 배정 조건 모두 만족한 차량만',()=>{const a={mechanized:true,support:true,destination:'강릉',org:'서울경기',type:'제설차',number:'0251',crew:['f','가']};assert.deepEqual(C.rows([a,{...a,mechanized:false},{...a,support:false},{...a,destination:''}]),[['서울경기','제설차','0251','강릉','f','가']]);});
test('한 명 또는 미선택은 빈 문자열 두 칸 유지',()=>{const a={mechanized:true,support:true,destination:'강릉',org:'서울경기',type:'제설차',number:251,crew:['c']};assert.deepEqual(C.rows([a])[0].slice(4),['c','']);});
test('엑셀은 6열·2행 머리글·행3부터 데이터',()=>{const f=C.xlsxFiles([['서울경기','제설차','0251','강릉','a','나']]),s=f['xl/worksheets/sheet1.xml'];assert.ok(s.includes('A1:F3')&&s.includes('A1:B1')&&s.includes('C1:C2')&&s.includes('0251'));assert.ok(f['xl/workbook.xml'].includes('name="붙여넣기"'));});
test('코드/기관 문자열을 XML과 수식으로 실행하지 않음',()=>{const s=C.xlsxFiles([['=1+1','<장비>','001','A&B','a','가']])['xl/worksheets/sheet1.xml'];assert.ok(s.includes('&lt;장비&gt;')&&s.includes('A&amp;B'));assert.ok(!s.includes('<f>'));});
for(const [name,ok,e] of tests)console.log((ok?'PASS ':'FAIL ')+name+(e?' '+e:''));
console.log(`${tests.filter(t=>t[1]).length}/${tests.length} 통과`);process.exit(tests.every(t=>t[1])?0:1);
