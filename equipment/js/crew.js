/* 인원 코드와 붙여넣기용 XLSX의 순수 계산. 실제 이름/연락처는 저장하지 않는다. */
(function(root){
  'use strict';
  const drivers=Array.from({length:26},(_,i)=>String.fromCharCode(97+i));
  const mechanics='가 나 다 라 마 바 사 아 자 차 카 타 파 하'.split(' ');
  const codes=new Set(drivers.concat(mechanics));
  const valid=a=>Array.isArray(a)&&a.length<=2&&a.every(x=>codes.has(x))&&new Set(a).size===a.length;
  const rows=records=>records.filter(x=>x.mechanized&&x.support&&x.destination).map(x=>[x.org,x.type,String(x.number),x.destination,(x.crew||[])[0]||'',(x.crew||[])[1]||'']);
  const xml=x=>String(x??'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function xlsxFiles(data){
    const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const table=[['지원처','','도공번호','지원기관','운전원1','운전원2'],['기관','장비','','','',''],...data];
    const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${ns}"><dimension ref="A1:F${table.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${[16,16,14,32,14,14].map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${table.map((row,i)=>`<row r="${i+1}" ht="24" customHeight="1">${row.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" s="${i<2?1:0}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><mergeCells count="5"><mergeCell ref="A1:B1"/>${['C','D','E','F'].map(c=>`<mergeCell ref="${c}1:${c}2"/>`).join('')}</mergeCells></worksheet>`;
    const styles=`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF23415D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left style="thin"><color rgb="FFD3DCE5"/></left><right style="thin"><color rgb="FFD3DCE5"/></right><top style="thin"><color rgb="FFD3DCE5"/></top><bottom style="thin"><color rgb="FFD3DCE5"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return {
      '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="붙여넣기" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':sheet,'xl/styles.xml':styles
    };
  }
  const api={drivers,mechanics,valid,rows,xlsxFiles};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SSCrew=api;
})(typeof window!=='undefined'?window:globalThis);
