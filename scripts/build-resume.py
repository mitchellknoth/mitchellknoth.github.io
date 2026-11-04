"""Build the downloadable resume from the same data as /resume/.

Run with Python and reportlab installed; the PDF is committed for static hosting.
"""
import json
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, KeepTogether
from reportlab.lib.pagesizes import letter

root = Path(__file__).resolve().parents[1]
data = json.loads((root / 'src/data/resume.json').read_text())
output = root / 'public/mitchell-knoth-resume.pdf'
ink = colors.HexColor('#212121')
accent = colors.HexColor('#735521')
styles = {
    'name': ParagraphStyle('name', fontName='Helvetica-Bold', fontSize=23, leading=26, textColor=ink, spaceAfter=4),
    'subtitle': ParagraphStyle('subtitle', fontName='Helvetica', fontSize=11, leading=14, textColor=accent, spaceAfter=5),
    'contact': ParagraphStyle('contact', fontName='Helvetica', fontSize=8.3, leading=11, textColor=ink, spaceAfter=8),
    'body': ParagraphStyle('body', fontName='Helvetica', fontSize=9, leading=12, textColor=ink, spaceAfter=4),
    'section': ParagraphStyle('section', fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=accent, spaceBefore=9, spaceAfter=5),
    'entry': ParagraphStyle('entry', fontName='Helvetica-Bold', fontSize=9.5, leading=12, textColor=ink, spaceBefore=6, spaceAfter=4),
    'bullet': ParagraphStyle('bullet', fontName='Helvetica', fontSize=8.7, leading=11.4, textColor=ink, leftIndent=9, firstLineIndent=-9, spaceAfter=3),
}
def p(text, kind='body'): return Paragraph(text, styles[kind])
def link(url,label): return f'<link href="{escape(url)}" color="#735521">{escape(label)}</link>'
story=[p(escape(data['name']), 'name'), p(escape(data['title'])+' | '+escape(data['focus']), 'subtitle'), p(escape(data['location'])+' | '+link('mailto:'+data['email'],data['email'])+' | '+link(data['website'],'Portfolio')+' | '+link(data['github'],'GitHub')+' | '+link(data['linkedin'],'LinkedIn'), 'contact'),p(escape(data['summary'])),p('EXPERIENCE - '+escape(data['employer'])+' | '+escape(data['employmentPeriod']), 'section'), p(escape(data['title'])+' - selected areas of responsibility', 'body')]
for entry in data['experience']:
    title=link(data['website']+entry['href'],entry['title'])+' | '+escape(entry['period'])
    first=p('- '+escape(entry['points'][0]), 'bullet')
    story.append(KeepTogether([p(title,'entry'),first]))
    story.extend(p('- '+escape(point), 'bullet') for point in entry['points'][1:])
story.extend([p('PUBLIC IMPLEMENTATION', 'section'),p(link(data['website']+data['publicWork']['href'], data['publicWork']['title'])+' - '+escape(data['publicWork']['summary']))])
story.extend([p('TECHNICAL FOCUS','section'),p(escape(data['skills'])),p('EDUCATION & SELECTED CREDENTIALS','section'),p(escape(data['education']))])
story.extend(p(escape(c),'body') for c in data['credentials'])
def footer(canvas, doc):
    canvas.saveState();canvas.setFont('Helvetica',7);canvas.setFillColor(colors.HexColor('#777777'));canvas.drawString(40,24,'Updated '+data['updated']);canvas.drawRightString(572,24,str(doc.page));canvas.restoreState()
SimpleDocTemplate(str(output),pagesize=letter,rightMargin=40,leftMargin=40,topMargin=35,bottomMargin=35,title=data['name']+' - Resume',author=data['name']).build(story,onFirstPage=footer,onLaterPages=footer)
print(output)
