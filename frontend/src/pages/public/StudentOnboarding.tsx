import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ComicPanel } from '../../components/ui';
import styles from './StudentOnboarding.module.css';

const SLIDES = [
  {
    mascot: '🛡️🤖',
    title: 'Привет!',
    desc: 'Я помогу тебе разобраться в правах и безопасности. Вместе мы пройдём интерактивные миссии!',
  },
  {
    mascot: '📖',
    title: 'Проходи истории и принимай решения',
    desc: 'Читай комиксы, выбирай действия героев и учись на их ошибках. Каждый выбор имеет значение!',
  },
  {
    mascot: '⭐',
    title: 'Зарабатывай XP и поддерживай streak',
    desc: 'За правильные ответы ты получаешь очки опыта. Заходи каждый день, чтобы поддерживать серию!',
  },
  {
    mascot: '🚀',
    title: 'Начнём!',
    desc: 'Твоё первое задание ждёт. Выбери миссию в штабе героя и отправляйся в путь!',
  },
];

export default function StudentOnboarding() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(0);

  const isLast = current === SLIDES.length - 1;
  const slide = SLIDES[current];

  const handleNext = () => {
    if (isLast) {
      navigate('/student/courses');
    } else {
      setCurrent((c) => c + 1);
    }
  };

  const handlePrev = () => {
    setCurrent((c) => Math.max(0, c - 1));
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <ComicPanel>
          <div className={styles.slide} key={current}>
            <span className={styles.mascot}>{slide.mascot}</span>
            <h2 className={styles.slideTitle}>{slide.title}</h2>
            <p className={styles.slideDesc}>{slide.desc}</p>
          </div>

          <div className={styles.dots}>
            {SLIDES.map((_, i) => (
              <div
                key={i}
                className={`${styles.dot} ${i === current ? styles.dotActive : ''}`}
              />
            ))}
          </div>

          <div className={styles.buttons}>
            {current > 0 && (
              <Button variant="outline" onClick={handlePrev}>
                Назад
              </Button>
            )}
            <Button variant="primary" onClick={handleNext}>
              {isLast ? 'Начать миссию' : 'Далее'}
            </Button>
          </div>
        </ComicPanel>
      </div>
    </div>
  );
}
