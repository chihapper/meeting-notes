// Build a Word (.docx) document for a meeting: title, attendees, summary,
// decisions, action items, and the full transcript. Returns a Buffer.
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

function buildMeetingDocx(meeting) {
  const children = [];

  children.push(new Paragraph({ text: meeting.title || 'Meeting', heading: HeadingLevel.HEADING_1 }));

  if (meeting.attendees && meeting.attendees.length) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'Attendees: ', bold: true }),
          new TextRun(meeting.attendees.join(', ')),
        ],
      })
    );
  }

  children.push(new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_2 }));
  children.push(new Paragraph(meeting.summary || '(none)'));

  if (meeting.decisions && meeting.decisions.length) {
    children.push(new Paragraph({ text: 'Decisions', heading: HeadingLevel.HEADING_2 }));
    meeting.decisions.forEach((d) => children.push(new Paragraph({ text: d, bullet: { level: 0 } })));
  }

  if (meeting.actionItems && meeting.actionItems.length) {
    children.push(new Paragraph({ text: 'Action items', heading: HeadingLevel.HEADING_2 }));
    meeting.actionItems.forEach((a) => {
      const bits = [a.task];
      if (a.owner && a.owner !== 'Unassigned') bits.push(`— ${a.owner}`);
      if (a.dueDate) bits.push(`(due ${a.dueDate})`);
      if (a.priority) bits.push(`[${a.priority}]`);
      children.push(new Paragraph({ text: bits.join(' '), bullet: { level: 0 } }));
    });
  }

  children.push(new Paragraph({ text: 'Transcript', heading: HeadingLevel.HEADING_2 }));
  (meeting.transcript || '').split(/\r?\n/).forEach((line) => children.push(new Paragraph(line)));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc); // Promise<Buffer>
}

module.exports = { buildMeetingDocx };
