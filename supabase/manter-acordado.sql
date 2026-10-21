-- MANTER O NUCLEO ACORDADO NO RENDER GRATUITO
--
-- O Render gratuito dorme depois de 15 minutos sem acesso. Dormindo, o
-- agendamento do dia 1 (e as revarreduras dos dias 6 e 16) so roda quando
-- alguem abrir o sistema. Este agendamento do proprio Supabase chama o
-- /api/health a cada 10 minutos, e o servico nao dorme.
--
-- Rode UMA VEZ no SQL Editor do mesmo projeto Supabase que guarda o NUCLEO,
-- trocando o endereco pelo do seu servico no Render.
--
-- Conta de horas: o Render gratuito da 750 horas por mes por workspace. Ligado
-- o mes inteiro, este servico usa ate 744. Se houver outro servico gratuito
-- ligado no mesmo workspace, use o horario comercial (mais abaixo).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- O dia inteiro (rodar de novo com o mesmo nome so atualiza o agendamento):
select cron.schedule(
  'nucleo-acordado',
  '*/10 * * * *',
  $$ select net.http_get(url := 'https://SEU-SERVICO.onrender.com/api/health', timeout_milliseconds := 60000) $$
);

-- Horario comercial no lugar do dia inteiro (o pg_cron do Supabase roda em
-- UTC: 08-23 UTC = 05h as 20h em Brasilia). O agendamento do dia 1 as 6h cai
-- dentro, e o que estiver atrasado roda quando o servico acordar:
--
-- select cron.schedule(
--   'nucleo-acordado',
--   '*/10 8-23 * * *',
--   $$ select net.http_get(url := 'https://SEU-SERVICO.onrender.com/api/health', timeout_milliseconds := 60000) $$
-- );
--
-- Conferir: select * from cron.job;
-- Desligar:  select cron.unschedule('nucleo-acordado');
