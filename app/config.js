/*
 * Configuração do aplicativo (ligação ao Supabase).
 *  - supabaseUrl e supabaseKey: Project URL e chave PÚBLICA ("publishable"/"anon") do projeto.
 *    Essa chave é feita para ficar dentro de apps; a proteção real está nas regras (RLS) e na criptografia.
 *    NUNCA coloque aqui a chave "secret" ou "service_role".
 *  - mode: "test" (só pacientes fictícios) ou "production" (só depois de ter hospedagem HDS adequada).
 */
window.ANAMNESE_CONFIG = {
  supabaseUrl: 'https://emmwemvureewcfsgbuxy.supabase.co',
  supabaseKey: 'sb_publishable_UDlCnhzJ30utlFQ4Q7_MAw_HFPDWRI3',
  mode: 'production'
};
