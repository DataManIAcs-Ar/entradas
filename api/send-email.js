import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'DataManIAcs <noreply@entradas.datamaniacs.com.ar>',
      to: [req.query.to || 'tomas.araguz@gmail.com'],
      subject: 'Test DataManIAcs ✓',
      html: '<h2>¡Funciona!</h2><p>Resend + entradas.datamaniacs.com.ar está operativo.</p>',
    });

    if (error) return res.status(400).json({ error });
    return res.status(200).json({ success: true, id: data.id });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
