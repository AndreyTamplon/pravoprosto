import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useApi } from '../../hooks/useApi';
import { getPromoCourses } from '../../api/client';
import { Button, ComicPanel, Badge, Spinner } from '../../components/ui';
import styles from './Landing.module.css';

const TOPIC_EMOJIS: Record<string, string> = {
  default: '📚',
};

const HOW_STEPS = [
  { icon: '🎯', title: 'Выбери миссию', desc: 'Найди тему, которая тебе интересна: мошенники, покупки, буллинг или другие.' },
  { icon: '📖', title: 'Пройди историю', desc: 'Читай комиксы, принимай решения и отвечай на вопросы вместе с героями.' },
  { icon: '🏆', title: 'Получи навык', desc: 'Зарабатывай XP, собирай награды и учись защищать свои права в реальной жизни.' },
];

const FOR_WHOM = [
  {
    icon: '🎒',
    title: 'Детям',
    desc: 'Интерактивные истории с решениями, XP-системой и наградами. Учиться легко, когда это игра!',
  },
  {
    icon: '👨\u200D👩\u200D👧',
    title: 'Родителям',
    desc: 'Отслеживайте прогресс ребёнка, смотрите статистику и будьте в курсе, что он изучает.',
  },
  {
    icon: '📚',
    title: 'Учителям',
    desc: 'Создавайте собственные миссии, делитесь ссылками с классом и смотрите результаты учеников.',
  },
];

export default function Landing() {
  const navigate = useNavigate();
  const { login, session } = useAuth();
  const { data: courses, loading } = useApi(getPromoCourses);

  const handleCta = () => {
    if (session?.authenticated) {
      navigate('/student/courses');
    } else {
      login();
    }
  };

  return (
    <div>
      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroHalftone} />
        <div className={styles.heroInner}>
          <div className={styles.heroText}>
            <h1 className={styles.heroTitle}>
              <span>Право Просто</span> — учись защищать себя через игру!
            </h1>
            <p className={styles.heroSub}>
              Интерактивные миссии по правовой грамотности для детей и подростков.
              Комиксы, квесты и XP-система делают обучение увлекательным.
            </p>
            <div className={styles.heroCta}>
              <Button variant="primary" size="lg" onClick={handleCta}>
                Начать
              </Button>
            </div>
          </div>
          <div className={styles.heroMascot} aria-hidden="true">
            🛡️🤖
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.howSection}>
        <h2 className={styles.sectionTitle}>Как это работает</h2>
        <div className={styles.steps}>
          {HOW_STEPS.map((step, i) => (
            <ComicPanel key={i} hoverable>
              <div className={styles.step}>
                <span className={styles.stepIcon}>{step.icon}</span>
                <div className={styles.stepNum}>{i + 1}</div>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepDesc}>{step.desc}</p>
              </div>
            </ComicPanel>
          ))}
        </div>
      </section>

      {/* Topics */}
      <section className={styles.topicsSection}>
        <div className={styles.topicsInner}>
          <h2 className={styles.sectionTitle}>Темы миссий</h2>
          {loading ? (
            <Spinner />
          ) : (
            <div className={styles.topicsGrid}>
              {(courses ?? []).map((course) => (
                <ComicPanel key={course.course_id} hoverable onClick={handleCta}>
                  <span className={styles.topicEmoji}>
                    {TOPIC_EMOJIS[course.course_id] ?? TOPIC_EMOJIS.default}
                  </span>
                  <h3 className={styles.topicTitle}>{course.title}</h3>
                  <p className={styles.topicDesc}>{course.description}</p>
                  <div className={styles.topicMeta}>
                    {course.age_min && course.age_max && (
                      <Badge variant="teal">
                        {course.age_min}–{course.age_max} лет
                      </Badge>
                    )}
                    <Badge variant="orange">{course.lesson_count} этапов</Badge>
                  </div>
                </ComicPanel>
              ))}
              {!courses?.length && !loading && (
                <ComicPanel hoverable onClick={handleCta}>
                  <span className={styles.topicEmoji}>🔐</span>
                  <h3 className={styles.topicTitle}>Мошенники в интернете</h3>
                  <p className={styles.topicDesc}>Научись распознавать фишинг, фейки и опасные ссылки.</p>
                </ComicPanel>
              )}
              {!courses?.length && !loading && (
                <ComicPanel hoverable onClick={handleCta}>
                  <span className={styles.topicEmoji}>🛒</span>
                  <h3 className={styles.topicTitle}>Покупки и возвраты</h3>
                  <p className={styles.topicDesc}>Узнай свои права как покупатель и что делать, если товар оказался бракованным.</p>
                </ComicPanel>
              )}
              {!courses?.length && !loading && (
                <ComicPanel hoverable onClick={handleCta}>
                  <span className={styles.topicEmoji}>🤝</span>
                  <h3 className={styles.topicTitle}>Буллинг и кибербуллинг</h3>
                  <p className={styles.topicDesc}>Как защитить себя и помочь другим в сложных ситуациях.</p>
                </ComicPanel>
              )}
              {!courses?.length && !loading && (
                <ComicPanel hoverable onClick={handleCta}>
                  <span className={styles.topicEmoji}>🔒</span>
                  <h3 className={styles.topicTitle}>Персональные данные</h3>
                  <p className={styles.topicDesc}>Почему важно беречь свои данные и как это делать правильно.</p>
                </ComicPanel>
              )}
            </div>
          )}
        </div>
      </section>

      {/* For whom */}
      <section className={styles.forWhomSection}>
        <h2 className={styles.sectionTitle}>Для кого</h2>
        <div className={styles.cols}>
          {FOR_WHOM.map((col) => (
            <ComicPanel key={col.title}>
              <div className={styles.col}>
                <span className={styles.colIcon}>{col.icon}</span>
                <h3 className={styles.colTitle}>{col.title}</h3>
                <p className={styles.colDesc}>{col.desc}</p>
              </div>
            </ComicPanel>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerLogo}>Право Просто</div>
          <p className={styles.footerNote}>
            Образовательная платформа по правовой грамотности для детей и подростков.
          </p>
        </div>
      </footer>
    </div>
  );
}
